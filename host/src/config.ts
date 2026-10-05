import { parseAllowedExtensions } from "./fileTypes.js";

export interface HostConfig {
  readonly apiToken: string;
  readonly publicBaseUrl: string;
  readonly dataDir: string;
  readonly port: number;
  readonly defaultTtlSeconds: number;
  readonly maxTtlSeconds: number;
  readonly maxFileBytes: number;
  /** HTML served at / (path relative to the working directory). */
  readonly landingPage: string;
  readonly maxTotalBytes: number;
  readonly sweepIntervalMs: number;
  /** Lower-case extensions without dots, sorted. */
  readonly allowedExtensions: readonly string[];
}

const MIN_TOKEN_LENGTH = 32;
const DAY_SECONDS = 86_400;
const MEBIBYTE = 1024 * 1024;

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function requireToken(env: Env): string {
  const token = env.SHARE_API_TOKEN;
  if (!token) throw new Error("SHARE_API_TOKEN is required");
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`SHARE_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return token;
}

function requireBaseUrl(env: Env): string {
  const raw = env.PUBLIC_BASE_URL;
  let url: URL | undefined;
  try {
    url = raw ? new URL(raw) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error("PUBLIC_BASE_URL must be an http(s) URL, e.g. https://share.example.com");
  }
  return url.href.replace(/\/+$/, "");
}

export function loadConfig(env: Env): HostConfig {
  const defaultTtlSeconds = positiveInt(env, "DEFAULT_TTL_SECONDS", DAY_SECONDS);
  const maxTtlSeconds = positiveInt(env, "MAX_TTL_SECONDS", 7 * DAY_SECONDS);
  if (defaultTtlSeconds > maxTtlSeconds) {
    throw new Error("DEFAULT_TTL_SECONDS must not exceed MAX_TTL_SECONDS");
  }
  return {
    apiToken: requireToken(env),
    publicBaseUrl: requireBaseUrl(env),
    dataDir: env.DATA_DIR || "/data",
    port: positiveInt(env, "PORT", 8080),
    defaultTtlSeconds,
    maxTtlSeconds,
    maxFileBytes: positiveInt(env, "MAX_FILE_MB", 100) * MEBIBYTE,
    landingPage: env.LANDING_PAGE || "site/index.html",
    // Keep below the persistent volume size so the disk never fills (default volume: 10Gi).
    maxTotalBytes: positiveInt(env, "MAX_TOTAL_MB", 9 * 1024) * MEBIBYTE,
    sweepIntervalMs: positiveInt(env, "SWEEP_INTERVAL_SECONDS", 60) * 1000,
    allowedExtensions: parseAllowedExtensions(env.ALLOWED_EXTENSIONS),
  };
}
