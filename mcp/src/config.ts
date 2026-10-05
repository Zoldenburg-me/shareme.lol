import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export interface McpConfig {
  readonly hostUrl: string;
  readonly apiToken: string;
  readonly allowedDirs: readonly string[];
  readonly defaultTtlHours: number;
  readonly maxFileBytes: number;
}

/** Host and token saved by `share-me-mcp login`. */
export interface StoredLogin {
  readonly host: string;
  readonly token: string;
}

type Env = Record<string, string | undefined>;

const MEBIBYTE = 1024 * 1024;
const DEFAULT_OUTBOX = "agent-output";
const LOGIN_HINT = "Run `npx -y share-me-mcp login https://your-share-host` in a terminal";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function positiveNumber(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

function parseHttpUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Validate a share host URL. Plain http is only allowed to loopback unless explicitly accepted. */
export function normalizeHostUrl(raw: string, allowInsecure = false): string {
  const url = parseHttpUrl(raw);
  if (!url) throw new Error(`The share host must be an http(s) URL such as https://share.example.com, got "${raw}"`);
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname) && !allowInsecure) {
    throw new Error(
      "The share host must use https unless it is localhost (the API token is sent on every request). " +
        "Set SHARE_ALLOW_INSECURE_HTTP=1 only if you accept that risk.",
    );
  }
  return url.href.replace(/\/+$/, "");
}

function allowedDirs(env: Env, home: string): string[] {
  const dirs = (env.SHARE_ALLOWED_DIRS ?? "").split(delimiter).filter(Boolean);
  if (dirs.length === 0) return [join(home, DEFAULT_OUTBOX)];
  const relative = dirs.find((d) => !isAbsolute(d));
  if (relative) throw new Error(`SHARE_ALLOWED_DIRS entries must be absolute paths, got "${relative}"`);
  return dirs;
}

/** Env vars win over the saved login, so either works on its own. */
export function loadMcpConfig(env: Env, stored?: StoredLogin, home: string = homedir()): McpConfig {
  const host = env.SHARE_HOST_URL || stored?.host;
  if (!host) throw new Error(`No share host configured. ${LOGIN_HINT}, or set SHARE_HOST_URL.`);
  const token = env.SHARE_API_TOKEN || stored?.token;
  if (!token) throw new Error(`No API token configured. ${LOGIN_HINT}, or set SHARE_API_TOKEN.`);
  return {
    hostUrl: normalizeHostUrl(host, env.SHARE_ALLOW_INSECURE_HTTP === "1"),
    apiToken: token,
    allowedDirs: allowedDirs(env, home),
    defaultTtlHours: positiveNumber(env, "SHARE_DEFAULT_TTL_HOURS", 24),
    maxFileBytes: positiveNumber(env, "SHARE_MAX_FILE_MB", 100) * MEBIBYTE,
  };
}
