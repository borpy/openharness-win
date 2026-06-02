import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipInstall = args.has("--skip-npm-install");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const version = pkg.version ?? "0.0.0";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const releaseDir = join(root, "release");
const stageDir = join(releaseDir, `openharness-v${version}-win32-${arch}`);
const appDir = join(stageDir, "resources", "app");
const zipPath = `${stageDir}.zip`;

function run(command, commandArgs, options = {}) {
  const useCmdShim = process.platform === "win32" && (command === "npm" || command === "npx");
  const spawnCommand = useCmdShim ? "cmd.exe" : command;
  const spawnArgs = useCmdShim ? ["/d", "/s", "/c", command, ...commandArgs] : commandArgs;
  const res = spawnSync(spawnCommand, spawnArgs, {
    cwd: options.cwd ?? root,
    env: { ...process.env, HUSKY: "0", ...options.env },
    encoding: "utf-8",
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
  });
  if (res.status !== 0 || res.error) {
    const detail = res.stderr || res.stdout || res.error?.message || "unknown error";
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${detail}`);
  }
  return res.stdout ?? "";
}

function requireBuiltArtifacts() {
  const required = [
    join(root, "dist", "main.js"),
    join(root, "dist", "sdk", "index.js"),
    join(root, "dist", "desktop", "main.js"),
    join(root, "dist", "desktop", "preload.js"),
    join(root, "dist", "desktop", "renderer", "index.html"),
  ];
  for (const file of required) {
    if (!existsSync(file)) {
      throw new Error(`Missing build artifact: ${file}. Run npm run build:all first.`);
    }
  }
}

function electronVersion() {
  const electronPkg = JSON.parse(readFileSync(join(root, "node_modules", "electron", "package.json"), "utf-8"));
  return electronPkg.version;
}

function electronDistDir() {
  const dist = join(root, "node_modules", "electron", "dist");
  if (!existsSync(join(dist, "electron.exe"))) {
    run("npx", ["install-electron"], { cwd: root });
  }
  if (!existsSync(join(dist, "electron.exe"))) {
    throw new Error("Electron runtime was not downloaded. Run npx install-electron and retry.");
  }
  return dist;
}

function minimalDesktopPackageJson() {
  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    type: pkg.type,
    main: "dist/desktop/main.js",
    bin: pkg.bin,
    exports: pkg.exports,
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
    engines: pkg.engines,
    license: pkg.license,
  };
}

function copyIfExists(source, target) {
  if (existsSync(source)) cpSync(source, target, { recursive: true });
}

function writeLaunchers() {
  const cmd = [
    "@echo off",
    "setlocal",
    'set "OH_ROOT=%~dp0"',
    '"%OH_ROOT%node.exe" "%OH_ROOT%resources\\app\\dist\\main.js" %*',
    "",
  ].join("\r\n");
  const ps1 = [
    "$ErrorActionPreference = 'Stop'",
    "$Root = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "& (Join-Path $Root 'node.exe') (Join-Path $Root 'resources/app/dist/main.js') @args",
    "",
  ].join("\r\n");
  writeFileSync(join(stageDir, "oh.cmd"), cmd);
  writeFileSync(join(stageDir, "openharness.cmd"), cmd);
  writeFileSync(join(stageDir, "oh.ps1"), ps1);
  writeFileSync(join(stageDir, "openharness.ps1"), ps1);
  writeFileSync(
    join(stageDir, "README-WINDOWS.txt"),
    [
      `OpenHarness ${version} Windows desktop bundle`,
      "",
      "Desktop app:",
      "  .\\OpenHarness.exe",
      "",
      "The desktop app opens a real OpenHarness CLI terminal and a right-side toolbox.",
      "Choose a workspace on first launch. Recent workspaces are stored under Electron userData.",
      "",
      "Direct CLI access is still bundled:",
      "  .\\oh.cmd",
      "  .\\oh.cmd --model ollama/qwen3:4b",
      "",
      "This bundle includes Electron, node.exe, the OpenHarness CLI runtime, and production npm dependencies.",
      "Local Ollama works out of the box when Ollama is running on http://localhost:11434.",
      "GitHub workflows require git plus GitHub CLI authentication: gh auth login",
      "",
    ].join("\r\n"),
  );
}

function copyNodeRuntime() {
  if (process.platform !== "win32") {
    throw new Error("Windows packaging must run on Windows so node.exe can be bundled.");
  }
  cpSync(process.execPath, join(stageDir, "node.exe"));
  const nodeDir = dirname(process.execPath);
  for (const entry of readdirSync(nodeDir)) {
    if (/^node.*\.dll$/i.test(entry)) {
      cpSync(join(nodeDir, entry), join(stageDir, entry));
    }
  }
}

function installProductionDependencies() {
  if (skipInstall) return;
  try {
    run("npm", ["ci", "--omit=dev", "--workspaces=false"], { cwd: appDir });
  } catch {
    run("npm", ["install", "--omit=dev", "--package-lock=false"], { cwd: appDir });
  }
}

function rebuildElectronNativeDependencies() {
  if (skipInstall) return;
  try {
    run(
      "npx",
      ["electron-rebuild", "-f", "--only", "node-pty", "--module-dir", appDir, "--version", electronVersion()],
      { cwd: root },
    );
  } catch (err) {
    const prebuild = join(appDir, "node_modules", "node-pty", "prebuilds", `win32-${arch}`, "pty.node");
    if (!existsSync(prebuild)) throw err;
    console.warn(
      [
        "Warning: electron-rebuild could not rebuild node-pty, but a Windows prebuild is present.",
        "Install Visual Studio Build Tools if the packaged Electron app cannot load node-pty on this machine.",
      ].join("\n"),
    );
  }
}

function stageElectronRuntime() {
  cpSync(electronDistDir(), stageDir, { recursive: true });
  const electronExe = join(stageDir, "electron.exe");
  const openHarnessExe = join(stageDir, "OpenHarness.exe");
  if (existsSync(openHarnessExe)) rmSync(openHarnessExe, { force: true });
  if (existsSync(electronExe)) {
    rmSync(openHarnessExe, { force: true });
    cpSync(electronExe, openHarnessExe);
    rmSync(electronExe, { force: true });
  }
}

function createZip() {
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  run(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:OH_STAGE_DIR -DestinationPath $env:OH_ZIP_PATH -Force",
    ],
    { env: { OH_STAGE_DIR: stageDir, OH_ZIP_PATH: zipPath } },
  );
}

function main() {
  requireBuiltArtifacts();
  if (dryRun) {
    console.log(`Windows desktop bundle: ${stageDir}`);
    console.log(`Zip: ${zipPath}`);
    console.log(`Electron: ${join(electronDistDir(), "electron.exe")}`);
    console.log(`Node: ${process.execPath}`);
    return;
  }

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });

  stageElectronRuntime();
  mkdirSync(appDir, { recursive: true });
  cpSync(join(root, "dist"), join(appDir, "dist"), { recursive: true });
  copyIfExists(join(root, "data"), join(appDir, "data"));
  copyIfExists(join(root, "README.md"), join(appDir, "README.md"));
  copyIfExists(join(root, "LICENSE"), join(appDir, "LICENSE"));
  copyIfExists(join(root, "package-lock.json"), join(appDir, "package-lock.json"));
  writeFileSync(join(appDir, "package.json"), `${JSON.stringify(minimalDesktopPackageJson(), null, 2)}\n`);

  installProductionDependencies();
  rebuildElectronNativeDependencies();
  copyNodeRuntime();
  writeLaunchers();
  createZip();

  console.log(`Created ${zipPath}`);
}

main();
