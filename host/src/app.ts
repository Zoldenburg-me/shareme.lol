import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import { text } from "node:stream/consumers";
import { createApi, filePath, isApiPath, type Accounts } from "./api.js";
import type { HostConfig } from "./config.js";
import { clientIp, HttpError, sendJson, tooManyRequests } from "./http.js";
import { FALLBACK_LANDING, type LegalPages } from "./landing.js";
import { LINK_GONE_PAGE, NOT_FOUND_HEADERS, PAGE_NOT_FOUND_PAGE } from "./notFoundPage.js";
import { createLimits } from "./limits.js";
import { isRenderableMarkdown, renderMarkdownPage } from "./markdownView.js";
import { renderSetupGuide } from "./setupGuide.js";
import { FileTooLargeError, type FileStore } from "./store.js";

type Clock = () => number;

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

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// File ids and short codes are bearer secrets: never write them to logs.
const redactIds = (url: string | undefined) =>
  (url ?? "").replace(/[A-Za-z0-9_-]{22}/g, "<id>").replace(/\/r\/[^/?#]+/g, "/r/<code>");

// Temporary and uncached: the link stops working when the file expires or is revoked.
const SHORT_LINK_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;

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
  "/terms": "terms",
  "/nutzungsbedingungen": "terms",
};

function sendNotFoundPage(res: ServerResponse, method: string, page: string): void {
  res.writeHead(404, NOT_FOUND_HEADERS);
  res.end(method === "HEAD" ? undefined : page);
}

export function createServer(
  config: HostConfig,
  store: FileStore,
  now: Clock = Date.now,
  pages: Pages = { landing: FALLBACK_LANDING, setup: renderSetupGuide(config.publicBaseUrl) },
  accounts?: Accounts,
): Server {
  const limits = createLimits(config);
  const handleApi = createApi(config, store, now, limits, accounts);

  // Markdown is shown rendered (still under the sandbox CSP); ?raw serves the original file.
  async function renderMarkdown(id: string, filename: string, method: string, res: ServerResponse): Promise<void> {
    const page = Buffer.from(renderMarkdownPage(await text(store.openBlob(id)), filename));
    res.writeHead(200, { ...DOWNLOAD_HEADERS, "content-type": "text/html; charset=utf-8", "content-length": page.length });
    res.end(method === "HEAD" ? undefined : page);
  }

  async function download(req: IncomingMessage, id: string, method: string, raw: boolean, res: ServerResponse): Promise<void> {
    const wait = limits.downloads.take(clientIp(req, config.trustCfConnectingIp), now());
    if (wait > 0) throw tooManyRequests("Too many downloads from your network; try again shortly", wait);
    const meta = store.get(id, now());
    if (!meta) {
      // People open these links in a browser, so a missing or expired one gets a page, not JSON.
      return sendNotFoundPage(res, method, LINK_GONE_PAGE);
    }
    if (!raw && isRenderableMarkdown(meta.contentType, meta.size)) return renderMarkdown(id, meta.filename, method, res);
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

  // Short codes are guessable in principle, so each IP gets a limited number of wrong ones.
  function followShortLink(req: IncomingMessage, code: string, method: string, res: ServerResponse): void {
    const ip = clientIp(req, config.trustCfConnectingIp);
    const blocked = limits.shortLinkMisses.retryAfter(ip, now());
    if (blocked > 0) throw tooManyRequests("Too many unknown links from your network; try again later", blocked);
    const meta = store.resolveShortCode(code, now());
    if (!meta) {
      limits.shortLinkMisses.take(ip, now());
      return sendNotFoundPage(res, method, LINK_GONE_PAGE);
    }
    res.writeHead(302, { ...SHORT_LINK_HEADERS, location: filePath(meta) });
    res.end();
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");
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
    if ((method === "GET" || method === "HEAD") && fileMatch) return download(req, fileMatch[1], method, searchParams.has("raw"), res);

    const shortMatch = /^\/r\/([^/]+)$/.exec(pathname);
    if ((method === "GET" || method === "HEAD") && shortMatch) return followShortLink(req, shortMatch[1], method, res);

    if (isApiPath(pathname)) return handleApi(req, res, pathname, method);
    // Browsers get a page for an unknown address; API clients and other methods keep JSON errors.
    if ((method === "GET" || method === "HEAD") && !pathname.startsWith("/api/")) {
      return sendNotFoundPage(res, method, PAGE_NOT_FOUND_PAGE);
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
      const headers = err instanceof HttpError ? err.headers : {};
      sendJson(res, status, { error: status === 500 ? "Internal server error" : (err as Error).message }, headers);
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
