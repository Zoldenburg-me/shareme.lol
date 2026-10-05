import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HostClient } from "./client.js";
import type { McpConfig } from "./config.js";
import { createShareTools, registerShareTools } from "./tools.js";

export function buildServer(config: McpConfig, fetchImpl: typeof fetch = fetch): McpServer {
  const server = new McpServer({ name: "share-me", version: "0.1.0" });
  registerShareTools(server, createShareTools(config, new HostClient(config.hostUrl, config.apiToken, fetchImpl)));
  return server;
}
