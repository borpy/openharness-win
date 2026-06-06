/**
 * MCP Server — expose OpenHarness tools as an MCP server over stdio.
 *
 * Now uses the official @modelcontextprotocol/sdk for spec compliance
 * (tools, capabilities, error codes, lifecycle, etc.). Addresses review #8.
 *
 * Other MCP clients (IDE extensions, other agents) can connect and use
 * OpenHarness's tools (Bash, Read, Write, Edit, Glob, Grep, etc.)
 */

import type { ToolContext, Tools } from "../Tool.js";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { zodToJsonSchemaSimple } from "./schema.js";

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
      version: "2.47.0", // TODO: source from package.json like in packaging
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
