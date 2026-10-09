import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
    /** Extra fields for the JSON error body, next to `error`. */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** Trust CF-Connecting-IP only when every request arrives through Cloudflare. */
export function clientIp(req: IncomingMessage, trustCfConnectingIp: boolean): string {
  const forwarded = req.headers["cf-connecting-ip"];
  if (trustCfConnectingIp && typeof forwarded === "string" && forwarded) return forwarded;
  return req.socket.remoteAddress ?? "unknown";
}

/** 429 with a Retry-After header (whole seconds, at least 1). */
export function tooManyRequests(message: string, retryAfterMs: number): HttpError {
  return new HttpError(429, message, { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

/** Read a small JSON request body; 413 past `maxBytes`, 400 if it isn't JSON. */
export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
}
