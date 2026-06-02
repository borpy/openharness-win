import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("desktop/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve("dist/desktop/renderer"),
    emptyOutDir: true,
  },
});
