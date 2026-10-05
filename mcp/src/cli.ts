import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HostClient } from "./client.js";
import { loadMcpConfig, normalizeHostUrl } from "./config.js";
import { readStoredLogin, saveLogin, storedLoginPath } from "./login.js";
import { buildServer } from "./server.js";

const REGISTER_HINT = "claude mcp add share-me --scope user -- npx -y share-me-mcp";

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  let data = "";
  for await (const chunk of stream) data += chunk;
  return data;
}

/** Read a secret without echoing it. Piped input (e.g. `pbpaste |`) is read as-is. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  if (!stdin.isTTY) return readAll(stdin).then((s) => s.trim());
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return resolve(value.trim());
        }
        if (ch === "\u0003") {
          finish();
          return reject(new Error("Login cancelled"));
        }
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

export async function login(hostArg: string | undefined): Promise<void> {
  if (!hostArg) throw new Error("Usage: npx -y share-me-mcp login https://your-share-host");
  const host = normalizeHostUrl(hostArg, process.env.SHARE_ALLOW_INSECURE_HTTP === "1");
  const token = await readHidden(`Paste the share-me token for ${host}: `);
  if (!token) throw new Error("No token entered");
  const path = storedLoginPath(homedir());
  const policy = await saveLogin({ host, token }, path, (l) => new HostClient(l.host, l.token).getConfig());
  const types = policy.allowedExtensions.map((e) => `.${e}`).join(" ");
  process.stderr.write(
    `Logged in to ${host}. Saved to ${path}.\nShareable types: ${types}\n\nNext, register the MCP server, for example:\n  ${REGISTER_HINT}\n`,
  );
}

export async function serve(): Promise<void> {
  const config = loadMcpConfig(process.env, readStoredLogin(storedLoginPath(homedir())));
  await Promise.all(config.allowedDirs.map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })));
  await buildServer(config).connect(new StdioServerTransport());
}
