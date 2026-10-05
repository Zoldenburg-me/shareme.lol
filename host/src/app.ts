import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import type { HostConfig } from "./config.js";
import { checkContent, contentTypeOf, extensionOf, HEAD_BYTES } from "./fileTypes.js";
import { FALLBACK_LANDING, type LegalPages } from "./landing.js";
import { renderSetupGuide } from "./setupGuide.js";
import { peek } from "./peek.js";
import { FileTooLargeError, type FileMeta, type FileStore } from "./store.js";

type Clock = () => number;

const MAX_FILENAME_LENGTH = 255;
const MINUTE_MS = 60_000;
// Large uploads on slow links need far more than Node's 5-minute default.
const REQUEST_TIMEOUT_MS = 30 * MINUTE_MS;
// Longer than typical ingress upstream keep-alive (nginx: 60s) to avoid sporadic 502s.
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS = 66_000;

// Served files are untrusted (e.g. agent-written HTML): sandbox them and stop sniffing/indexing.
const DOWNLOAD_HEADERS = {
  "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "private, no-store",
} as const;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return match !== null && timingSafeEqual(sha256(match[1]), sha256(token));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function parseFilename(req: IncomingMessage): string {
  const raw = req.headers["x-filename"];
  let name = "";
  try {
    name = typeof raw === "string" ? decodeURIComponent(raw).trim() : "";
  } catch {
    throw new HttpError(400, "x-filename must be URI-encoded");
  }
  if (!name || name.length > MAX_FILENAME_LENGTH || /[/\\\u0000-\u001f]/.test(name)) {
    throw new HttpError(400, "x-filename header must be a plain file name");
  }
  return name;
}

function parseTtl(req: IncomingMessage, config: HostConfig): number {
  const raw = req.headers["x-ttl-seconds"];
  if (raw === undefined || raw === "") return config.defaultTtlSeconds;
  const ttl = Number(raw);
  if (!Number.isInteger(ttl) || ttl <= 0) throw new HttpError(400, "x-ttl-seconds must be a positive integer");
  return Math.min(ttl, config.maxTtlSeconds);
}

/** The extension decides how the file is served; the uploader's Content-Type is ignored. */
function requireAllowedExtension(filename: string, allowed: readonly string[]): string {
  const ext = extensionOf(filename);
  if (ext && allowed.includes(ext)) return ext;
  const list = allowed.map((e) => `.${e}`).join(", ");
  throw new HttpError(415, `File type ${ext ? `.${ext}` : "(no extension)"} is not allowed. Allowed: ${list}`);
}

// File ids are bearer secrets: never write them to logs.
const redactIds = (url: string | undefined) => (url ?? "").replace(/[A-Za-z0-9_-]{22}/g, "<id>");

// The landing page is trusted, first-party HTML: own fonts, inline styles and scripts, no framing.
const LANDING_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
} as const;

const FONT_HEADERS = {
  "content-type": "font/woff2",
  "x-content-type-options": "nosniff",
  "cache-control": "public, max-age=31536000, immutable",
} as const;

function toPublic(meta: FileMeta, baseUrl: string) {
  return {
    id: meta.id,
    url: `${baseUrl}/f/${meta.id}/${encodeURIComponent(meta.filename)}`,
    filename: meta.filename,
    size: meta.size,
    expiresAt: new Date(meta.expiresAt).toISOString(),
  };
}

/** First-party pages: the landing page at /, the agent setup guide at /setup, and the legal pages. */
export interface Pages {
  readonly landing: string;
  readonly setup: string;
  readonly legal?: LegalPages;
  readonly fonts?: ReadonlyMap<string, Buffer>;
}

const SETUP_PATHS = new Set(["/setup", "/llms.txt"]);
const LEGAL_PATHS: Readonly<Record<string, keyof LegalPages>> = {
  "/imprint": "imprint",
  "/impressum": "imprint",
  "/privacy": "privacy",
  "/datenschutz": "privacy",
};

export function createServer(
  config: HostConfig,
  store: FileStore,
  now: Clock = Date.now,
  pages: Pages = { landing: FALLBACK_LANDING, setup: renderSetupGuide(config.publicBaseUrl) },
): Server {
  async function upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > config.maxFileBytes) throw new HttpError(413, "File too large");
    const remainingQuota = config.maxTotalBytes - store.totalBytes();
    if (declared > remainingQuota || remainingQuota <= 0) throw new HttpError(507, "Share host storage is full; try again later");
    const filename = parseFilename(req);
    const ext = requireAllowedExtension(filename, config.allowedExtensions);
    const ttlSeconds = parseTtl(req, config);
    const { head, body, discard } = await peek(req, HEAD_BYTES);
    const mismatch = checkContent(ext, head);
    if (mismatch) {
      discard();
      throw new HttpError(415, mismatch);
    }
    const meta = await store.create({
      filename,
      contentType: contentTypeOf(ext),
      ttlSeconds,
      maxBytes: Math.min(config.maxFileBytes, remainingQuota),
      body,
      clock: now,
    });
    sendJson(res, 201, toPublic(meta, config.publicBaseUrl));
  }

  function download(id: string, method: string, res: ServerResponse): void {
    const meta = store.get(id, now());
    if (!meta) throw new HttpError(404, "Link not found or expired");
    res.writeHead(200, {
      ...DOWNLOAD_HEADERS,
      "content-type": meta.contentType,
      "content-length": meta.size,
      "content-disposition": `inline; filename*=UTF-8''${encodeRfc5987(meta.filename)}`,
    });
    if (method === "HEAD") return void res.end();
    // pipeline destroys the file stream if the viewer disconnects mid-download (no fd leak).
    pipeline(store.openBlob(id), res, (err) => {
      if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") console.error("[share-host] download failed:", err.message);
    });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "GET" && pathname === "/healthz") return sendJson(res, 200, { ok: true });
    if ((method === "GET" || method === "HEAD") && pathname === "/") {
      res.writeHead(200, LANDING_HEADERS);
      res.end(method === "HEAD" ? undefined : pages.landing);
      return;
    }
    const font = pathname.startsWith("/fonts/") ? pages.fonts?.get(pathname.slice("/fonts/".length)) : undefined;
    if ((method === "GET" || method === "HEAD") && font) {
      res.writeHead(200, { ...FONT_HEADERS, "content-length": font.length });
      res.end(method === "HEAD" ? undefined : font);
      return;
    }
    const legalPage = pages.legal && Object.hasOwn(LEGAL_PATHS, pathname) ? pages.legal[LEGAL_PATHS[pathname]] : undefined;
    if ((method === "GET" || method === "HEAD") && legalPage !== undefined) {
      res.writeHead(200, LANDING_HEADERS);
      res.end(method === "HEAD" ? undefined : legalPage);
      return;
    }
    if ((method === "GET" || method === "HEAD") && SETUP_PATHS.has(pathname)) {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-cache" });
      res.end(method === "HEAD" ? undefined : pages.setup);
      return;
    }

    const fileMatch = /^\/f\/([^/]+)(?:\/[^/]*)?$/.exec(pathname);
    if ((method === "GET" || method === "HEAD") && fileMatch) return download(fileMatch[1], method, res);

    if (pathname === "/api/config" || pathname === "/api/files" || pathname.startsWith("/api/files/")) {
      if (!isAuthorized(req, config.apiToken)) throw new HttpError(401, "Unauthorized");
      if (method === "POST" && pathname === "/api/files") return upload(req, res);
      if (method === "GET" && pathname === "/api/config") {
        const { allowedExtensions, maxFileBytes, maxTtlSeconds } = config;
        return sendJson(res, 200, { allowedExtensions, maxFileBytes, maxTtlSeconds });
      }
      if (method === "GET" && pathname === "/api/files") {
        return sendJson(res, 200, { files: store.list(now()).map((m) => toPublic(m, config.publicBaseUrl)) });
      }
      const idMatch = /^\/api\/files\/([^/]+)$/.exec(pathname);
      if (method === "DELETE" && idMatch) {
        if (!(await store.delete(idMatch[1]))) throw new HttpError(404, "Link not found");
        res.writeHead(204).end();
        return;
      }
    }
    throw new HttpError(404, "Not found");
  }

  const server = createHttpServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : err instanceof FileTooLargeError ? 413 : 500;
      if (status === 500) console.error(`[share-host] ${req.method} ${redactIds(req.url)} failed:`, err);
      if (res.headersSent) return void res.destroy();
      // Drain a reasonably sized unread upload so the client receives this response instead of
      // ECONNRESET; refuse to drain bodies that declared they are over the limit.
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > config.maxFileBytes) res.setHeader("connection", "close");
      else if (!req.readableEnded && !req.destroyed) req.resume();
      sendJson(res, status, { error: status === 500 ? "Internal server error" : (err as Error).message });
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
