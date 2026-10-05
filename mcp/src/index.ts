#!/usr/bin/env node
import { login, serve } from "./cli.js";

const [command, arg] = process.argv.slice(2);

try {
  if (command === "login") await login(arg);
  else await serve();
} catch (err) {
  // stdout is the MCP channel; diagnostics go to stderr.
  console.error("[share-me-mcp]", err instanceof Error ? err.message : err);
  process.exit(1);
}
