import { readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostPolicy } from "./client.js";
import { DEFAULT_HOST, normalizeHostUrl, type StoredLogin } from "./config.js";

const RELOGIN = "log in again with `npx -y share-me-mcp login <host>`";

export const storedLoginPath = (home: string): string => join(home, ".config", "share-me", "config.json");

const isStoredLogin = (value: unknown): value is StoredLogin =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as StoredLogin).host === "string" &&
  typeof (value as StoredLogin).token === "string";

/** Read the saved login; undefined when nobody has logged in yet. */
export function readStoredLogin(path: string): StoredLogin | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON; ${RELOGIN}`);
  }
  if (!isStoredLogin(parsed)) throw new Error(`${path} is missing the host or token; ${RELOGIN}`);
  return { host: parsed.host, token: parsed.token };
}

async function writeLogin(login: StoredLogin, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode only applies when the file is created.
  await chmod(path, 0o600);
}

/** Verify the token against the host, then save it readable by the owner only. */
export async function saveLogin(
  login: StoredLogin,
  path: string,
  verify: (login: StoredLogin) => Promise<HostPolicy>,
): Promise<HostPolicy> {
  const policy = await verify(login);
  await writeLogin(login, path);
  return policy;
}

type Env = Record<string, string | undefined>;

/**
 * Make sure this machine has credentials: a token from the environment, a saved login, or a
 * fresh self-service token from the host (shareme.lol unless SHARE_HOST_URL says otherwise).
 * Returns the login it saved or found; undefined when the environment supplies the token.
 */
export async function ensureLogin(
  env: Env,
  path: string,
  requestToken: (host: string) => Promise<{ token: string }>,
): Promise<StoredLogin | undefined> {
  if (env.SHARE_API_TOKEN) return undefined;
  const stored = readStoredLogin(path);
  if (stored) return stored;
  const host = normalizeHostUrl(env.SHARE_HOST_URL || DEFAULT_HOST, env.SHARE_ALLOW_INSECURE_HTTP === "1");
  const { token } = await requestToken(host);
  const login = { host, token };
  await writeLogin(login, path);
  return login;
}
