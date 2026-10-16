import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { toReqLike, type AcceptResult } from "@zold/accept";
import type { HostConfig } from "./config.js";
import { clientIp, HttpError, readJson } from "./http.js";
import type { Principal } from "./plans.js";
import type { FileMeta, FileStore } from "./store.js";
import { formatAmount, priceFor, type Payments } from "./x402.js";
import type { X402Config } from "./x402Config.js";

export interface Extended {
  readonly meta: FileMeta;
  readonly headers: Readonly<Record<string, string>>;
}

type Clock = () => number;
type Refusal = Extract<AcceptResult, { kind: "respond" }>;

const MAX_BODY_BYTES = 1024;
const DAY_SECONDS = 86_400;
const HOUR_MS = 3_600_000;
const FILE_REF_LENGTH = 16;
// The path every extension is priced and paid under: file ids are secrets, so they stay out of
// offers and the payment ledger. A payment still binds to its link through `fileRef` in its meta.
const PAID_PATH = "/api/files/extend";
// The payment's outcome is unknown or still settling: the money may move, so the client must not pay again.
const PENDING_CODES = new Set(["IN_PROGRESS", "SETTLEMENT_TIMEOUT", "SETTLEMENT_UNKNOWN"]);
const PENDING_RETRY_SECONDS = "5";

function days(seconds: number): string {
  const n = Math.round((seconds / DAY_SECONDS) * 10) / 10;
  return `${n} ${n === 1 ? "day" : "days"}`;
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The ledger's stand-in for a file id: sha256 cut to 16 hex, enough to match a live file, useless as a link. */
export const fileRef = (fileId: string): string => createHash("sha256").update(fileId).digest("hex").slice(0, FILE_REF_LENGTH);

const decodeBase64Json = (value: string | undefined): unknown =>
  value === undefined ? undefined : JSON.parse(Buffer.from(value, "base64").toString("utf8"));

/** @zold/accept's refusal as this API's error: its code, its headers, and the fresh offer on a 402. */
function refused(x402: X402Config, result: Refusal, amount: number): HttpError {
  const headers = Object.fromEntries(
    Object.entries(result.headers).map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => k !== "content-type"),
  );
  const parsed: unknown = JSON.parse(result.body);
  const code = isObject(parsed) && typeof parsed.error === "string" ? parsed.error : "INTERNAL";
  // Any 5xx may come after a broadcast; retrying the same payment is always safe, paying again is not.
  if (PENDING_CODES.has(code) || result.status >= 500) {
    return new HttpError(
      503,
      "This payment hasn't settled yet. Once it does, the link is extended without another request. " +
        "To check, retry this request with the same payment; don't sign a new one.",
      { ...headers, "retry-after": headers["retry-after"] ?? PENDING_RETRY_SECONDS },
      { code, paymentStatus: "pending" },
    );
  }
  if (code === "NONCE_REPLAY") {
    return new HttpError(409, "This payment was already used for another extension (another link, or a quote from an earlier hour). " +
      "A payment that was still settling extends its own link once it settles; for anything else, get a new quote.", headers, { code });
  }
  if (result.status !== 402) return new HttpError(result.status, `Payment not accepted (${code})`, headers, { code });
  const message = code === "PAYMENT_REQUIRED"
    ? "Payment required to keep this link longer than your plan allows"
    : `Payment not accepted (${code}); pay the quote in PAYMENT-REQUIRED`;
  const price = formatAmount(amount, x402.assetDecimals);
  return new HttpError(402, message, headers, { code, price, currency: x402.assetSymbol, paymentRequired: decodeBase64Json(headers["payment-required"]) });
}

async function readTtl(req: IncomingMessage): Promise<number> {
  const body = await readJson(req, MAX_BODY_BYTES);
  const ttl = isObject(body) ? body.ttlSeconds : undefined;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0) throw new HttpError(400, "ttlSeconds must be a positive integer");
  return ttl;
}

/**
 * POST /api/files/:id/extend: a link may live up to its plan's limit (counted from upload) for free;
 * past that, each started 30 days is paid for with x402, up to the host's longest lifetime.
 */
/** Keeps a link until at least `until`, never shortening it, so a payment delivered twice changes nothing. */
async function extendTo(store: FileStore, id: string, until: number, now: number): Promise<FileMeta> {
  const current = store.get(id, now);
  const meta = current && current.expiresAt >= until ? current : await store.setExpiry(id, until, now);
  if (!meta) throw new HttpError(404, "Link not found");
  return meta;
}

/**
 * Runs @zold/accept's reconciliation, then extends the links of payments that settled after their request
 * ended (it timed out, or the payer never came back). Run it on a timer in the one host process.
 */
export function createReconciler(store: FileStore, payments: Payments) {
  // Paid but undeliverable (the link is gone): reported once per process, refunded by hand.
  const reported = new Set<string>();

  async function deliver(now: number): Promise<number> {
    // shortcut: scans the whole ledger each run; index settled-undelivered rows once it holds many thousands.
    const owed = (await payments.ledger.list()).filter((row) => row.status === "settled" && !row.delivered);
    if (owed.length === 0) return 0;
    const live = new Map(store.list(now).map((meta) => [fileRef(meta.id), meta]));
    let delivered = 0;
    for (const row of owed) {
      const meta = live.get(row.meta.fileRef ?? "");
      if (!meta) {
        if (!reported.has(row.claimKey)) payments.acceptor.reportError(new Error(`payment for link ${row.meta.fileRef} settled, but the link is gone`));
        reported.add(row.claimKey);
        continue;
      }
      await extendTo(store, meta.id, Number(row.meta.until), now);
      await payments.ledger.markDelivered(row.claimKey);
      delivered += 1;
    }
    return delivered;
  }

  return async function reconcile(now: number) {
    const report = await payments.acceptor.reconcileOwed();
    return { ...report, delivered: await deliver(now) };
  };
}

export function createExtender(config: HostConfig, store: FileStore, now: Clock, payments?: Payments) {
  // One extension per link at a time, so two payments can't both buy the same days.
  const busy = new Set<string>();

  async function setExpiry(id: string, expiresAt: number): Promise<FileMeta> {
    const meta = await store.setExpiry(id, expiresAt, now());
    if (!meta) throw new HttpError(404, "Link not found");
    return meta;
  }

  async function paid(req: IncomingMessage, meta: FileMeta, requestedTarget: number, paidFrom: number, who: Principal): Promise<Extended> {
    const x402 = config.x402;
    if (!x402 || !payments) {
      throw new HttpError(403, `Links on your plan can live at most ${days(who.limits.maxTtlSeconds)}, and this host doesn't sell longer ones`);
    }
    // Paid time ends on the hour, so a quote still holds when the client comes back with the payment.
    const target = Math.ceil(requestedTarget / HOUR_MS) * HOUR_MS;
    // Already paid through that hour (e.g. a retry once the payment settled): nothing more to buy.
    if (target <= meta.expiresAt) return { meta, headers: {} };
    if (target > meta.createdAt + x402.maxLifetimeSeconds * 1000) {
      throw new HttpError(400, `A link can live at most ${days(x402.maxLifetimeSeconds)} in total`);
    }
    const amount = priceFor(x402, Math.ceil((target - paidFrom) / 1000), meta.size);
    // A retry of the same payment must price the same: same link, same end, same amount.
    const price = { amount: BigInt(amount), meta: { fileRef: fileRef(meta.id), until: String(target) } };
    const request = { ...toReqLike(req), path: PAID_PATH, clientIp: clientIp(req, config.trustCfConnectingIp) };
    // Settles on chain before it returns: the link is only extended once the money has moved.
    const result = await payments.acceptor.handle(request, { price });
    if (result.kind === "respond") throw refused(x402, result, amount);
    try {
      // A replayed delivery, or one the reconciler made first, is a no-op: extendTo never shortens.
      return { meta: await extendTo(store, meta.id, target, now()), headers: result.headers };
    } catch (err) {
      // Paid but not delivered (the link went away meanwhile): the operator has to refund it by hand.
      payments.acceptor.reportError(new Error(`payment for link ${fileRef(meta.id)} settled, but the link could not be extended`));
      throw err;
    }
  }

  async function apply(req: IncomingMessage, meta: FileMeta, ttlSeconds: number, who: Principal): Promise<Extended> {
    const target = now() + ttlSeconds * 1000;
    // Never shortens: revoking is how a link ends early.
    if (target <= meta.expiresAt) return { meta, headers: {} };
    const freeUntil = meta.createdAt + who.limits.maxTtlSeconds * 1000;
    if (target <= freeUntil) return { meta: await setExpiry(meta.id, target), headers: {} };
    return paid(req, meta, target, Math.max(meta.expiresAt, freeUntil), who);
  }

  return async function extend(req: IncomingMessage, id: string, who: Principal): Promise<Extended> {
    const ttlSeconds = await readTtl(req);
    const meta = store.get(id, now());
    // A user asking for someone else's link gets the same 404 as for a missing one.
    if (!meta || (who.kind === "user" && meta.owner !== who.id)) throw new HttpError(404, "Link not found");
    if (busy.has(id)) throw new HttpError(409, "This link is already being extended; try again in a moment");
    busy.add(id);
    try {
      return await apply(req, meta, ttlSeconds, who);
    } finally {
      busy.delete(id);
    }
  };
}
