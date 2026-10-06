import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
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
