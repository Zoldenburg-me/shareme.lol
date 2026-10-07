import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostConfig } from "./config.js";
import { checkContent, contentTypeOf, extensionOf, HEAD_BYTES } from "./fileTypes.js";
import { clientIp, HttpError, sendJson, tooManyRequests } from "./http.js";
import { peek } from "./peek.js";
import type { Limits } from "./limits.js";
import type { SignupLimiter } from "./signupLimiter.js";
import type { FileMeta, FileStore } from "./store.js";
import type { TokenStore } from "./tokens.js";

/** Self-service accounts: per-agent tokens plus the signup throttle. */
export interface Accounts {
  readonly tokens: TokenStore;
  readonly limiter: SignupLimiter;
}

/** The admin token (SHARE_API_TOKEN) sees everything; a self-service token sees only its own files. */
type Principal = { readonly kind: "admin" } | { readonly kind: "user"; readonly id: string };

type Clock = () => number;

const MAX_FILENAME_LENGTH = 255;
const MEBIBYTE = 1024 * 1024;
const NO_STORE = { "cache-control": "no-store" };

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const megabytes = (bytes: number) => `${Math.round(bytes / MEBIBYTE)} MB`;

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

function toPublic(meta: FileMeta, baseUrl: string) {
  return {
    id: meta.id,
    url: `${baseUrl}/f/${meta.id}/${encodeURIComponent(meta.filename)}`,
    filename: meta.filename,
    size: meta.size,
    expiresAt: new Date(meta.expiresAt).toISOString(),
  };
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api/config" || pathname === "/api/files" || pathname.startsWith("/api/files/") ||
    pathname === "/api/tokens" || pathname.startsWith("/api/tokens/");
}

export function createApi(config: HostConfig, store: FileStore, now: Clock, limits: Limits, accounts?: Accounts) {
  function authenticate(req: IncomingMessage): Principal | undefined {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!match) return undefined;
    if (timingSafeEqual(sha256(match[1]), sha256(config.apiToken))) return { kind: "admin" };
    const record = accounts?.tokens.find(match[1]);
    return record ? { kind: "user", id: record.id } : undefined;
  }

  async function signup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.resume();
    if (!accounts || !config.openSignup) throw new HttpError(403, "Signup is closed on this host; ask its operator for a token");
    if (!accounts.limiter.allow(clientIp(req, config.trustCfConnectingIp), now())) {
      throw new HttpError(429, "Too many signups from your network; try again in an hour");
    }
    const { token, record } = await accounts.tokens.issue(now());
    const { allowedExtensions, maxFileBytes, maxTtlSeconds, tokenQuotaBytes } = config;
    sendJson(res, 201, {
      token,
      id: record.id,
      host: config.publicBaseUrl,
      quotaBytes: tokenQuotaBytes,
      maxFileBytes,
      maxTtlSeconds,
      allowedExtensions,
    }, NO_STORE);
  }

  async function upload(req: IncomingMessage, res: ServerResponse, who: Principal): Promise<void> {
    const wait = who.kind === "user" ? limits.uploads.take(who.id, now()) : 0;
    if (wait > 0) throw tooManyRequests(`Upload limit reached (${config.uploadsPerTokenPerHour} per hour); try again later`, wait);
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > config.maxFileBytes) throw new HttpError(413, "File too large");
    const hostRemaining = config.maxTotalBytes - store.totalBytes();
    if (declared > hostRemaining || hostRemaining <= 0) throw new HttpError(507, "Share host storage is full; try again later");
    const ownerRemaining = who.kind === "user" ? config.tokenQuotaBytes - store.usedBytes(who.id) : Infinity;
    if (declared > ownerRemaining || ownerRemaining <= 0) {
      throw new HttpError(507, `Your storage quota (${megabytes(config.tokenQuotaBytes)}) is used up; revoke links or wait for them to expire`);
    }
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
      maxBytes: Math.min(config.maxFileBytes, hostRemaining, ownerRemaining),
      body,
      clock: now,
      ...(who.kind === "user" ? { owner: who.id } : {}),
    });
    // The token may have been revoked while the body was streaming; its cascade has already run.
    if (who.kind === "user" && !accounts?.tokens.hasId(who.id)) {
      await store.delete(meta.id);
      throw new HttpError(401, "Token was revoked during the upload");
    }
    sendJson(res, 201, toPublic(meta, config.publicBaseUrl));
  }

  function policy(who: Principal) {
    const { allowedExtensions, maxFileBytes, maxTtlSeconds } = config;
    const account = who.kind === "user"
      ? { account: { id: who.id, usedBytes: store.usedBytes(who.id), quotaBytes: config.tokenQuotaBytes } }
      : {};
    return { allowedExtensions, maxFileBytes, maxTtlSeconds, ...account };
  }

  async function deleteFile(id: string, who: Principal, res: ServerResponse): Promise<void> {
    // A user asking for someone else's link gets the same 404 as for a missing one.
    const owned = who.kind === "admin" || store.get(id, now())?.owner === who.id;
    if (!owned || !(await store.delete(id))) throw new HttpError(404, "Link not found");
    res.writeHead(204).end();
  }

  async function deleteToken(target: string, who: Principal, res: ServerResponse): Promise<void> {
    if (!accounts) throw new HttpError(404, "Not found");
    if (target === "me" && who.kind === "admin") throw new HttpError(400, "The admin token is set in the host config and can't be deleted here");
    const id = target === "me" && who.kind === "user" ? who.id : target;
    if (who.kind === "user" && id !== who.id) throw new HttpError(403, "Only the host admin can revoke other tokens");
    if (!(await accounts.tokens.revoke(id))) throw new HttpError(404, "Token not found");
    await store.deleteByOwner(id);
    res.writeHead(204).end();
  }

  /** Handles an /api request (see isApiPath). */
  return async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, method: string): Promise<void> {
    const ip = clientIp(req, config.trustCfConnectingIp);
    const busy = limits.api.take(ip, now());
    if (busy > 0) throw tooManyRequests("Too many requests; slow down", busy);
    if (method === "POST" && pathname === "/api/tokens") return signup(req, res);
    // Once an IP has sent too many wrong tokens, refuse it before even checking the token.
    const locked = limits.authFailures.retryAfter(ip, now());
    if (locked > 0) throw tooManyRequests("Too many failed logins from your network; try again later", locked);
    const who = authenticate(req);
    if (!who) {
      // Only a wrong token counts. Requests with no token are what any other site can make a
      // visitor's browser send (adding Authorization needs CORS, which this API never grants).
      if (/^Bearer /.test(req.headers.authorization ?? "")) limits.authFailures.take(ip, now());
      throw new HttpError(401, "Unauthorized");
    }
    if (method === "POST" && pathname === "/api/files") return upload(req, res, who);
    if (method === "GET" && pathname === "/api/config") return sendJson(res, 200, policy(who));
    if (method === "GET" && pathname === "/api/files") {
      const owner = who.kind === "user" ? who.id : undefined;
      return sendJson(res, 200, { files: store.list(now(), owner).map((m) => toPublic(m, config.publicBaseUrl)) });
    }
    const fileId = /^\/api\/files\/([^/]+)$/.exec(pathname)?.[1];
    if (method === "DELETE" && fileId) return deleteFile(fileId, who, res);
    const tokenId = /^\/api\/tokens\/([^/]+)$/.exec(pathname)?.[1];
    if (method === "DELETE" && tokenId) return deleteToken(tokenId, who, res);
    throw new HttpError(404, "Not found");
  };
}
