/**
 * MCP Server — expose OpenHarness tools as an MCP server over stdio.
 *
 * Now uses the official @modelcontextprotocol/sdk for spec compliance
 * (tools, capabilities, error codes, lifecycle, etc.). Addresses review #8.
 *
 * Other MCP clients (IDE extensions, other agents) can connect and use
 * OpenHarness's tools (Bash, Read, Write, Edit, Glob, Grep, etc.)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ToolContext, Tools } from "../Tool.js";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { zodToJsonSchemaSimple } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const serverVersion = pkg.version ?? "0.0.0";

export class McpServer {
  private tools: Tools;
  private context: ToolContext;
  private sdkServer?: SdkMcpServer;

  constructor(tools: Tools, context: ToolContext) {
    this.tools = tools;
    this.context = context;
  }

  /** Start listening on stdio using the official SDK */
  start(): void {
    const sdk = new SdkMcpServer({
      name: "openharness",
      version: serverVersion, // MCP spec snapshot; see SDK for current protocol details
    });

    // Register all tools with the SDK (inputSchema via our wrapper for now)
    for (const t of this.tools) {
      sdk.registerTool(
        t.name,
        {
          description: t.prompt().slice(0, 200),
          inputSchema: zodToJsonSchemaSimple(t.inputSchema) as any, // adapter for SDK
        },
        async (args: any) => {
          try {
            const result = await t.call(args, this.context);
            return {
              content: [{ type: "text", text: result.output }],
              isError: result.isError,
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
              isError: true,
            };
          }
        },
      );
    }

    const transport = new StdioServerTransport();
    sdk.connect(transport).catch((err) => {
      process.stderr.write(`[mcp-server] connect error: ${err}\n`);
    });

    process.stderr.write("[mcp-server] OpenHarness MCP server ready (SDK-backed)\n");
    this.sdkServer = sdk;
  }
}
