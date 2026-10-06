import { Readable } from "node:stream";

export interface SharedLink {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
  readonly size: number;
  readonly expiresAt: string;
}

const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

export interface UploadRequest {
  readonly body: Readable;
  readonly size: number;
  readonly filename: string;
  readonly ttlSeconds: number;
}

/** Upload policy published by the host at GET /api/config. */
export interface HostPolicy {
  /** Lower-case extensions without dots. */
  readonly allowedExtensions: readonly string[];
  readonly maxFileBytes: number;
  readonly maxTtlSeconds: number;
  /** Present for self-service tokens: storage used and allowed. */
  readonly account?: { readonly id: string; readonly usedBytes: number; readonly quotaBytes: number };
}

export interface Signup {
  readonly token: string;
  readonly id: string;
  readonly quotaBytes?: number;
}

const SIGNUP_TIMEOUT_MS = 30_000;

async function errorDetail(res: Response): Promise<string> {
  const detail = await res.json().then((b: { error?: string }) => b.error).catch(() => undefined);
  return `Share host returned ${res.status}${detail ? `: ${detail}` : ""}`;
}

/** Ask a host with open signup for a new self-service token. */
export async function signup(host: string, fetchImpl: typeof fetch = fetch): Promise<Signup> {
  let res: Response;
  try {
    res = await fetchImpl(`${host}/api/tokens`, { method: "POST", signal: AbortSignal.timeout(SIGNUP_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Could not reach share host at ${host}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(await errorDetail(res));
  return (await res.json()) as Signup;
}

/** Thin client for the share host's authenticated /api/files endpoints. */
export class HostClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async upload(req: UploadRequest): Promise<SharedLink> {
    const res = await this.request("/api/files", {
      method: "POST",
      headers: {
        // The host derives the served type from the extension; this is just the transport type.
        "content-type": "application/octet-stream",
        "content-length": String(req.size),
        "x-filename": encodeURIComponent(req.filename),
        "x-ttl-seconds": String(req.ttlSeconds),
      },
      body: Readable.toWeb(req.body) as ReadableStream,
      duplex: "half",
    } as RequestInit, UPLOAD_TIMEOUT_MS);
    return (await res.json()) as SharedLink;
  }

  async getConfig(): Promise<HostPolicy> {
    const res = await this.request("/api/config", { method: "GET" });
    return (await res.json()) as HostPolicy;
  }

  async list(): Promise<SharedLink[]> {
    const res = await this.request("/api/files", { method: "GET" });
    return ((await res.json()) as { files: SharedLink[] }).files;
  }

  async revoke(id: string): Promise<void> {
    await this.request(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  private async request(path: string, init: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.apiToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`Could not reach share host at ${this.baseUrl}: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(await errorDetail(res));
    return res;
  }
}
