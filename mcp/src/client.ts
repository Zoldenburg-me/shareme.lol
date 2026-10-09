import { Readable } from "node:stream";

export interface SharedLink {
  readonly id: string;
  readonly url: string;
  /** Short /r/<code> link that redirects to `url`; absent from hosts without short links. */
  readonly shortUrl?: string;
  readonly filename: string;
  readonly size: number;
  readonly expiresAt: string;
  /** Set when the host's plan cut the requested TTL short. */
  readonly ttlCapped?: boolean;
  readonly requestedTtlSeconds?: number;
  readonly maxTtlSeconds?: number;
  /** "pending" after a paid extension the host couldn't confirm was settled. */
  readonly paymentStatus?: "pending";
}

/** An x402 v2 settlement receipt (the host's PAYMENT-RESPONSE). */
export interface PaymentReceipt {
  readonly success: boolean;
  readonly transaction?: string;
  readonly network?: string;
  readonly payer?: string;
}

export type ExtendResult =
  | { readonly kind: "extended"; readonly link: SharedLink; readonly receipt?: PaymentReceipt }
  | {
      readonly kind: "payment_required";
      readonly message: string;
      readonly price?: string;
      readonly currency?: string;
      /** The decoded x402 PaymentRequired object, for the agent's wallet to sign. */
      readonly paymentRequired: unknown;
      /** The same, exactly as the host sent it in PAYMENT-REQUIRED (base64). */
      readonly header: string;
    };

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
  readonly account?: {
    readonly id: string;
    readonly plan?: "free" | "pro";
    readonly planUntil?: string;
    readonly usedBytes: number;
    readonly quotaBytes: number;
  };
  /** How the host takes payment for keeping links past the plan's limit. */
  readonly payments?: {
    readonly x402?: { readonly network: string; readonly currency: string; readonly payTo?: string; readonly maxLifetimeSeconds: number };
  };
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

  /** Keep a link `ttlSeconds` from now; past the plan's limit the host asks for an x402 payment. */
  async extend(id: string, ttlSeconds: number, payment?: string): Promise<ExtendResult> {
    const res = await this.request(`/api/files/${encodeURIComponent(id)}/extend`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(payment ? { "payment-signature": payment } : {}) },
      body: JSON.stringify({ ttlSeconds }),
    }, API_TIMEOUT_MS, true);
    const header = res.headers.get("payment-required");
    if (res.status === 402) {
      if (!header) throw new Error(await errorDetail(res));
      const body = (await res.json().catch(() => ({}))) as { error?: string; price?: string; currency?: string };
      return {
        kind: "payment_required",
        message: body.error ?? "Payment required",
        ...(body.price ? { price: body.price } : {}),
        ...(body.currency ? { currency: body.currency } : {}),
        paymentRequired: decodeBase64Json(header),
        header,
      };
    }
    const receipt = res.headers.get("payment-response");
    const link = (await res.json()) as SharedLink;
    return receipt ? { kind: "extended", link, receipt: decodeBase64Json(receipt) as PaymentReceipt } : { kind: "extended", link };
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

  private async request(path: string, init: RequestInit, timeoutMs = API_TIMEOUT_MS, allowPaymentRequired = false): Promise<Response> {
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
    if (!res.ok && !(allowPaymentRequired && res.status === 402)) throw new Error(await errorDetail(res));
    return res;
  }
}

function decodeBase64Json(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    throw new Error("Share host sent a malformed x402 payment header");
  }
}
