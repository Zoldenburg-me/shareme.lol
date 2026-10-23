#!/usr/bin/env node
import { login, serve, signup } from "./cli.js";
import { isPatchedNode } from "./nodeVersion.js";

if (!isPatchedNode(process.versions.node)) {
  // Warn, not exit: npx ignores engines, and refusing to start would break agents mid-session.
  console.error(`[share-me-mcp] Node ${process.versions.node} misses the October 2026 security fixes; update to 22.23.4+, 24.22.1+ or 26.12.1+.`);
}

const [command, arg] = process.argv.slice(2);

try {
  if (command === "login") await login(arg);
  else if (command === "signup") await signup(arg);
  else await serve();
} catch (err) {
  // stdout is the MCP channel; diagnostics go to stderr.
  console.error("[share-me-mcp]", err instanceof Error ? err.message : err);
  process.exit(1);
}
