import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostConfig } from "./config.js";
import { checkContent, contentTypeOf, extensionOf, HEAD_BYTES } from "./fileTypes.js";
import { createExtender, type Payments } from "./extend.js";
import { clientIp, HttpError, readJson, sendJson, tooManyRequests } from "./http.js";
import { peek } from "./peek.js";
import type { Limits } from "./limits.js";
import { limitsFor, planOf, type Principal } from "./plans.js";
import { Reservations } from "./reservations.js";
import { paceUpload } from "./uploadPace.js";
import type { SignupLimiter } from "./signupLimiter.js";
import type { FileMeta, FileStore } from "./store.js";
import type { TokenStore } from "./tokens.js";

/** Self-service accounts: per-agent tokens plus the signup throttle. */
export interface Accounts {
  readonly tokens: TokenStore;
  readonly limiter: SignupLimiter;
}

type Clock = () => number;

const MAX_FILENAME_LENGTH = 255;
const MEBIBYTE = 1024 * 1024;
const MAX_PLAN_BODY_BYTES = 1024;
const NO_STORE = { "cache-control": "no-store" };
// Suggested wait when a token already has its maximum number of uploads streaming.
const UPLOAD_BUSY_RETRY_MS = 5_000;

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

/** The requested TTL, and what the plan allows of it. */
function parseTtl(req: IncomingMessage, config: HostConfig, maxTtlSeconds: number): { requested: number; ttl: number } {
  const raw = req.headers["x-ttl-seconds"];
  if (raw === undefined || raw === "") return { requested: config.defaultTtlSeconds, ttl: Math.min(config.defaultTtlSeconds, maxTtlSeconds) };
  const requested = Number(raw);
  if (!Number.isInteger(requested) || requested <= 0) throw new HttpError(400, "x-ttl-seconds must be a positive integer");
  return { requested, ttl: Math.min(requested, maxTtlSeconds) };
}

// Plan changes are admin-only for now; a payment flow will call the same TokenStore.setPlan.
async function parsePlanUntil(req: IncomingMessage): Promise<number | undefined> {
  const body = await readJson(req, MAX_PLAN_BODY_BYTES);
  const until = typeof body === "object" && body !== null ? (body as { until?: unknown }).until : undefined;
  if (until === null) return undefined;
  const at = typeof until === "string" ? Date.parse(until) : NaN;
  if (Number.isNaN(at)) throw new HttpError(400, "until must be an ISO date, or null to end the plan");
  return at;
}

/** The extension decides how the file is served; the uploader's Content-Type is ignored. */
function requireAllowedExtension(filename: string, allowed: readonly string[]): string {
  const ext = extensionOf(filename);
  if (ext && allowed.includes(ext)) return ext;
  const list = allowed.map((e) => `.${e}`).join(", ");
  throw new HttpError(415, `File type ${ext ? `.${ext}` : "(no extension)"} is not allowed. Allowed: ${list}`);
}

export const filePath = (meta: FileMeta): string => `/f/${meta.id}/${encodeURIComponent(meta.filename)}`;

function toPublic(meta: FileMeta, baseUrl: string) {
  return {
    id: meta.id,
    url: `${baseUrl}${filePath(meta)}`,
    ...(meta.shortCode ? { shortUrl: `${baseUrl}/r/${meta.shortCode}` } : {}),
    filename: meta.filename,
    size: meta.size,
    expiresAt: new Date(meta.expiresAt).toISOString(),
  };
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api/config" || pathname === "/api/files" || pathname.startsWith("/api/files/") ||
    pathname === "/api/tokens" || pathname.startsWith("/api/tokens/");
}

export function createApi(config: HostConfig, store: FileStore, now: Clock, limits: Limits, accounts?: Accounts, payments?: Payments) {
  const reservations = new Reservations();
  const extend = createExtender(config, store, now, payments);

  function authenticate(req: IncomingMessage): Principal | undefined {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!match) return undefined;
    // The operator gets the best plan the host has; quotas don't apply to it.
    if (timingSafeEqual(sha256(match[1]), sha256(config.apiToken))) return { kind: "admin", limits: limitsFor(config, "pro") };
    const record = accounts?.tokens.find(match[1]);
    if (!record) return undefined;
    const plan = planOf(record, now());
    return { kind: "user", id: record.id, plan, limits: limitsFor(config, plan) };
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
    const owner = who.kind === "user" ? who.id : undefined;
    // Each streaming upload holds quota until it ends, so cap how many one token can hold at once;
    // checked before the hourly limit so a refused request doesn't use up that allowance.
    if (owner && reservations.ownerFiles(owner) >= config.concurrentUploadsPerToken) {
      throw tooManyRequests(
        `${config.concurrentUploadsPerToken} uploads are already in progress for this token; wait for one to finish`,
        UPLOAD_BUSY_RETRY_MS,
      );
    }
    const wait = owner ? limits.uploads.take(owner, now()) : 0;
    if (wait > 0) throw tooManyRequests(`Upload limit reached (${config.uploadsPerTokenPerHour} per hour); try again later`, wait);
    const hasLength = req.headers["content-length"] !== undefined;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (hasLength && declared === 0) throw new HttpError(400, "File is empty");
    if (declared > config.maxFileBytes) throw new HttpError(413, "File too large");
    // Everything from here to reservations.hold() is synchronous, so no other upload can claim
    // the same free space between the check and the hold.
    const hostRemaining = config.maxTotalBytes - store.totalBytes() - reservations.totalBytes();
    if (declared > hostRemaining || hostRemaining <= 0) throw new HttpError(507, "Share host storage is full; try again later");
    const { quotaBytes, maxFiles, maxTtlSeconds } = who.limits;
    const ownerRemaining = owner ? quotaBytes - store.usedBytes(owner) - reservations.ownerBytes(owner) : Infinity;
    if (declared > ownerRemaining || ownerRemaining <= 0) {
      throw new HttpError(507, `Your storage quota (${megabytes(quotaBytes)}) is used up; revoke links or wait for them to expire`);
    }
    if (owner && store.fileCount(owner) + reservations.ownerFiles(owner) >= maxFiles) {
      throw new HttpError(507, `You already have ${maxFiles} files shared; revoke links or wait for them to expire`);
    }
    const filename = parseFilename(req);
    const ext = requireAllowedExtension(filename, config.allowedExtensions);
    const { requested, ttl: ttlSeconds } = parseTtl(req, config, maxTtlSeconds);
    // A declared length is all the body can be; without one, hold everything this upload may use.
    const maxBytes = hasLength ? declared : Math.min(config.maxFileBytes, hostRemaining, ownerRemaining);
    const release = reservations.hold(maxBytes, owner);
    // Paced from the moment the space is held, so a client can't sit on it by trickling bytes.
    const paced = paceUpload(req, config.minUploadBytesPerSecond, config.uploadPaceWindowMs);
    try {
      const { head, body, discard } = await peek(paced.body, HEAD_BYTES);
      if (head.length === 0) throw new HttpError(400, "File is empty");
      const mismatch = checkContent(ext, head);
      if (mismatch) {
        discard();
        throw new HttpError(415, mismatch);
      }
      // Say so when the plan cut the TTL short, so the agent can extend (or pay for) the rest.
      const capped = requested > ttlSeconds ? { ttlCapped: true, requestedTtlSeconds: requested, maxTtlSeconds } : {};
      return await finishUpload(res, who, capped, await store.create({
        filename,
        contentType: contentTypeOf(ext),
        ttlSeconds,
        maxBytes,
        body,
        clock: now,
        ...(owner ? { owner } : {}),
      }));
    } finally {
      paced.stop();
      release();
    }
  }

  async function finishUpload(res: ServerResponse, who: Principal, extra: Record<string, unknown>, meta: FileMeta): Promise<void> {
    // The token may have been revoked while the body was streaming; its cascade has already run.
    if (who.kind === "user" && !accounts?.tokens.hasId(who.id)) {
      await store.delete(meta.id);
      throw new HttpError(401, "Token was revoked during the upload");
    }
    sendJson(res, 201, { ...toPublic(meta, config.publicBaseUrl), ...extra });
  }

  function planUntil(id: string): { planUntil?: string } {
    const until = accounts?.tokens.byId(id)?.plan?.until;
    return until && until > now() ? { planUntil: new Date(until).toISOString() } : {};
  }

  function paymentTerms() {
    const x402 = config.x402;
    if (!x402 || !payments) return {};
    const { network, asset, assetSymbol: currency, payTo, pricePerFileMonth, pricePerGbMonth, maxLifetimeSeconds } = x402;
    return { payments: { x402: { network, asset, currency, payTo, pricePerFileMonth, pricePerGbMonth, maxLifetimeSeconds } } };
  }

  function policy(who: Principal) {
    const { allowedExtensions, maxFileBytes } = config;
    const account = who.kind === "user"
      ? { account: { id: who.id, plan: who.plan, ...planUntil(who.id), usedBytes: store.usedBytes(who.id), quotaBytes: who.limits.quotaBytes } }
      : {};
    return { allowedExtensions, maxFileBytes, maxTtlSeconds: who.limits.maxTtlSeconds, ...account, ...paymentTerms() };
  }

  async function extendFile(req: IncomingMessage, res: ServerResponse, id: string, who: Principal): Promise<void> {
    const { meta, headers, paymentPending } = await extend(req, id, who);
    const pending = paymentPending ? { paymentStatus: "pending" } : {};
    sendJson(res, 200, { ...toPublic(meta, config.publicBaseUrl), ...pending }, { ...NO_STORE, ...headers });
  }

  async function setPlan(req: IncomingMessage, res: ServerResponse, id: string, who: Principal): Promise<void> {
    if (who.kind !== "admin") throw new HttpError(403, "Only the host admin can change plans");
    if (!accounts) throw new HttpError(404, "Not found");
    const until = await parsePlanUntil(req);
    const record = await accounts.tokens.setPlan(id, until);
    if (!record) throw new HttpError(404, "Token not found");
    sendJson(res, 200, planOf(record, now()) === "pro" ? { id, plan: "pro", ...planUntil(id) } : { id, plan: "free" });
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
    const signingUp = method === "POST" && pathname === "/api/tokens";
    const who = signingUp ? undefined : authenticate(req);
    // A valid token gets its own bucket on its IP, so a neighbour on the same NAT can't use it up;
    // signups and requests without a valid token share the IP's bucket.
    const bucket = !who ? ip : who.kind === "admin" ? `admin ${ip}` : `user ${who.id} ${ip}`;
    const busy = limits.api.take(bucket, now());
    if (busy > 0) throw tooManyRequests("Too many requests; slow down", busy);
    if (signingUp) return signup(req, res);
    if (!who) {
      // The lockout only refuses wrong tokens, so a neighbour on the same IP or NAT can't lock out
      // valid ones. Guessing is still bounded by the per-IP api limit above, and tokens are 256-bit
      // (the admin token at least 32 characters), so it can't succeed in practice.
      const locked = limits.authFailures.retryAfter(ip, now());
      if (locked > 0) throw tooManyRequests("Too many failed logins from your network; try again later", locked);
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
    const extendId = /^\/api\/files\/([^/]+)\/extend$/.exec(pathname)?.[1];
    if (method === "POST" && extendId) return extendFile(req, res, extendId, who);
    const tokenId = /^\/api\/tokens\/([^/]+)$/.exec(pathname)?.[1];
    if (method === "DELETE" && tokenId) return deleteToken(tokenId, who, res);
    const planId = /^\/api\/tokens\/([^/]+)\/plan$/.exec(pathname)?.[1];
    if (method === "PUT" && planId) return setPlan(req, res, planId, who);
    throw new HttpError(404, "Not found");
  };
}
