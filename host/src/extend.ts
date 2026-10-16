import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { toReqLike, type AcceptResult, type SellerPayment } from "@zold/accept";
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
/**
 * Keeps a link until at least `until`, never shortening it, so delivering a payment twice changes nothing.
 * A link the sweep kept past its old expiry for a pending payment is revived.
 */
async function extendTo(store: FileStore, id: string, until: number, now: number): Promise<FileMeta> {
  const current = store.get(id, now);
  const meta = current && current.expiresAt >= until ? current : await store.setExpiry(id, until, now, true);
  if (!meta) throw new HttpError(404, "Link not found");
  return meta;
}

/**
 * Extends the link a settled payment bought, then marks it delivered (payments are handled with
 * deferDelivery). Delivery is at-least-once, so this is safe to repeat: extendTo never shortens.
 */
async function deliverPayment(store: FileStore, payments: Payments, id: string, row: Pick<SellerPayment, "claimKey" | "meta">, now: number) {
  const meta = await extendTo(store, id, Number(row.meta.until), now);
  await payments.acceptor.confirmDelivery(row.claimKey);
  return meta;
}

/** What the sweep must keep: links with a payment in flight, still settling, or settled but not yet extended. */
export async function paymentHolds(payments: Payments): Promise<(meta: FileMeta) => boolean> {
  // shortcut: the ledger has no query for open rows, so this scans it; add one once it holds many thousands.
  const open = (await payments.ledger.list()).filter((row) => row.status === "owed" || row.status === "submitted");
  const held = new Set([...open, ...(await payments.ledger.undelivered())].map((row) => row.meta.fileRef));
  return (meta) => payments.paying.has(meta.id) || held.has(fileRef(meta.id));
}

/**
 * Runs @zold/accept's reconciliation, then extends the links of payments that settled after their request
 * ended (it timed out, the process died, or the payer never came back). Run it on a timer in the one host
 * process, and once before the first sweep.
 */
export function createReconciler(store: FileStore, payments: Payments) {
  // Paid but undeliverable (the link was revoked): reported once per process, refunded by hand.
  const reported = new Set<string>();

  async function deliver(now: number): Promise<number> {
    const owed = await payments.ledger.undelivered();
    if (owed.length === 0) return 0;
    const onDisk = new Map(store.onDisk().map((meta) => [fileRef(meta.id), meta]));
    let delivered = 0;
    for (const row of owed) {
      const meta = onDisk.get(row.meta.fileRef ?? "");
      if (!meta) {
        if (!reported.has(row.claimKey)) payments.acceptor.reportError(new Error(`payment for link ${row.meta.fileRef} settled, but the link is gone`));
        reported.add(row.claimKey);
        continue;
      }
      await deliverPayment(store, payments, meta.id, row, now);
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

  /** The ledger row of the payment this request carries, if this host has seen it before (only to price it). */
  async function priorPayment(req: IncomingMessage): Promise<SellerPayment | undefined> {
    const header = req.headers["payment-signature"];
    return payments && typeof header === "string" ? payments.acceptor.lookup(header) : undefined;
  }

  /** Takes the payment for `target` at `price`, then extends the link and records the delivery. */
  async function settle(req: IncomingMessage, meta: FileMeta, target: number, price: { amount: bigint; meta: Record<string, string> }, pay: Payments, x402: X402Config): Promise<Extended> {
    const request = { ...toReqLike(req), path: PAID_PATH, clientIp: clientIp(req, config.trustCfConnectingIp) };
    pay.paying.add(meta.id);
    try {
      // Settles on chain before it returns: the link is only extended once the money has moved.
      // deferDelivery: marked delivered only once the link is extended, so a failure here is retried.
      const result = await pay.acceptor.handle(request, { price, deferDelivery: true });
      if (result.kind === "respond") throw refused(x402, result, Number(price.amount));
      return { meta: await deliverPayment(store, pay, meta.id, { claimKey: result.paid.claimKey, meta: price.meta }, now()), headers: result.headers };
    } finally {
      pay.paying.delete(meta.id);
    }
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
    return settle(req, meta, target, { amount: BigInt(amount), meta: { fileRef: fileRef(meta.id), until: String(target) } }, payments, x402);
  }

  /** A retry of a payment this host already knows, for this link: resolved as it was priced, whatever the clock says now. */
  async function retry(req: IncomingMessage, meta: FileMeta, row: SellerPayment): Promise<Extended> {
    const x402 = config.x402 as X402Config;
    const pay = payments as Payments;
    const target = Number(row.meta.until);
    if (row.delivered && target <= meta.expiresAt) return { meta, headers: {} };
    return settle(req, meta, target, { amount: BigInt(row.amount), meta: { ...row.meta } }, pay, x402);
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
    const prior = await priorPayment(req);
    const forThisLink = prior?.meta.fileRef === fileRef(id) ? prior : undefined;
    // A link kept past its expiry for this very payment is still found, so its payer can check on it.
    const meta = store.get(id, now()) ?? (forThisLink ? store.onDisk().find((m) => m.id === id) : undefined);
    // A user asking for someone else's link gets the same 404 as for a missing one.
    if (!meta || (who.kind === "user" && meta.owner !== who.id)) throw new HttpError(404, "Link not found");
    if (busy.has(id)) throw new HttpError(409, "This link is already being extended; try again in a moment");
    busy.add(id);
    try {
      return await (forThisLink ? retry(req, meta, forThisLink) : apply(req, meta, ttlSeconds, who));
    } finally {
      busy.delete(id);
    }
  };
}
