import type { IncomingMessage } from "node:http";
import type { HostConfig } from "./config.js";
import { HttpError, readJson, tooManyRequests } from "./http.js";
import { fileRef, type PaymentLedger, type PaymentRecord } from "./payments.js";
import type { Principal } from "./plans.js";
import type { FileMeta, FileStore } from "./store.js";
import {
  decodePayment, encodeHeader, formatAmount, matchesRequirements, PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER, paymentRequired, priceFor, requirementsFor, type Facilitator, type PaymentPayload,
  type PaymentRequirements, type SettleResponse,
} from "./x402.js";
import type { X402Config } from "./x402Config.js";

/** How this host takes payments; absent when it takes none. */
export interface Payments {
  readonly facilitator: Facilitator;
  readonly ledger: PaymentLedger;
}

export interface Extended {
  readonly meta: FileMeta;
  readonly headers: Readonly<Record<string, string>>;
  /** The facilitator didn't confirm settlement; the extension stands and the payment awaits reconciling. */
  readonly paymentPending?: boolean;
}

type Clock = () => number;

const MAX_BODY_BYTES = 1024;
const DAY_SECONDS = 86_400;
const HOUR_MS = 3_600_000;
// Facilitator calls in flight at once, across all tokens; each can take up to its timeout.
const MAX_PAYMENTS_IN_FLIGHT = 8;
const PAYMENT_BUSY_RETRY_MS = 5_000;

function days(seconds: number): string {
  const n = Math.round((seconds / DAY_SECONDS) * 10) / 10;
  return `${n} ${n === 1 ? "day" : "days"}`;
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function nonceOf(payment: PaymentPayload): string | undefined {
  const auth = payment.payload.authorization;
  const nonce = isObject(auth) ? auth.nonce : undefined;
  return typeof nonce === "string" && nonce ? nonce : undefined;
}

/** A success answer we can actually record: a transaction on the network we asked for. */
const isSettlement = (s: SettleResponse, requirements: PaymentRequirements): boolean =>
  typeof s.transaction === "string" && s.transaction !== "" && s.network === requirements.network;

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
export function createExtender(config: HostConfig, store: FileStore, now: Clock, payments?: Payments) {
  // One extension per link at a time, so two payments can't both buy the same days.
  const busy = new Set<string>();
  const inFlight = new Set<string>();

  async function setExpiry(id: string, expiresAt: number): Promise<FileMeta> {
    const meta = await store.setExpiry(id, expiresAt, now());
    if (!meta) throw new HttpError(404, "Link not found");
    return meta;
  }

  function paymentNeeded(x402: X402Config, requirements: PaymentRequirements, seconds: number, error?: string): HttpError {
    // The resource names the service, not the link: file ids are secrets and this goes to the facilitator.
    const description = `Keep a share-me link up to ${Math.ceil(seconds / DAY_SECONDS)} more day(s)`;
    const required = paymentRequired(`${config.publicBaseUrl}/api/files/extend`, description, requirements, error);
    return new HttpError(
      402,
      error ?? "Payment required to keep this link longer than your plan allows",
      { [PAYMENT_REQUIRED_HEADER]: encodeHeader(required) },
      { price: formatAmount(Number(requirements.amount), x402.assetDecimals), currency: x402.assetSymbol, paymentRequired: required },
    );
  }

  // Undo an extension whose payment definitely failed. If even that fails, the link keeps unpaid
  // time, which is the safe side for the payer; say so loudly.
  async function revert(meta: FileMeta): Promise<void> {
    try {
      await store.setExpiry(meta.id, meta.expiresAt, now());
    } catch (err) {
      // Only the code: fs error messages contain the file's path, and so its secret id.
      console.error("[share-host] could not undo an unpaid extension:", (err as NodeJS.ErrnoException).code ?? "unknown error");
    }
  }

  async function record(pay: Payments, entry: PaymentRecord): Promise<void> {
    // The money has (maybe) moved, so a ledger failure must not fail the request. Logs leave out
    // the payer's address (personal data); the nonce finds the transfer on chain.
    await pay.ledger.append(entry).catch((err: unknown) => {
      const { payer: _personal, ...loggable } = entry;
      console.error("[share-host] could not record payment:", JSON.stringify(loggable), (err as NodeJS.ErrnoException).code ?? "unknown error");
    });
  }

  async function settle(meta: FileMeta, target: number, payment: PaymentPayload, requirements: PaymentRequirements, seconds: number, payer: string | undefined, x402: X402Config, pay: Payments): Promise<Extended> {
    // Extend first, then settle: if the file vanished meanwhile, nobody is charged.
    const extended = await setExpiry(meta.id, target);
    const base = {
      at: now(), network: requirements.network, amount: requirements.amount, asset: requirements.asset, fileRef: fileRef(meta.id), seconds,
      ...(nonceOf(payment) ? { nonce: nonceOf(payment) } : {}), ...(meta.owner ? { owner: meta.owner } : {}),
    };
    let settled: SettleResponse | undefined;
    try {
      settled = await pay.facilitator.settle(payment, requirements);
    } catch (err) {
      // Logged without the link: file ids are secrets. The ledger entry below carries the nonce.
      console.error("[share-host] payment settlement had no clear answer, recording it as pending:", (err as Error).message);
      settled = undefined;
    }
    if (settled && !settled.success) {
      await revert(meta);
      throw paymentNeeded(x402, requirements, seconds, settled.errorReason ?? "Payment could not be settled");
    }
    if (!settled || !isSettlement(settled, requirements)) {
      // No clear answer: the transfer may already be on chain, so keep what was paid for and
      // leave a pending record (with the nonce) to reconcile, rather than charge for nothing.
      await record(pay, { ...base, status: "pending", transaction: "", ...(payer ? { payer } : {}) });
      return { meta: extended, headers: {}, paymentPending: true };
    }
    const settledPayer = settled.payer ?? payer;
    await record(pay, { ...base, status: "settled", transaction: settled.transaction, ...(settledPayer ? { payer: settledPayer } : {}) });
    return { meta: extended, headers: { [PAYMENT_RESPONSE_HEADER]: encodeHeader(settled) } };
  }

  async function paid(req: IncomingMessage, meta: FileMeta, requestedTarget: number, paidFrom: number, who: Principal): Promise<Extended> {
    const x402 = config.x402;
    if (!x402 || !payments) {
      throw new HttpError(403, `Links on your plan can live at most ${days(who.limits.maxTtlSeconds)}, and this host doesn't sell longer ones`);
    }
    // Paid time ends on the hour, so a quote still holds when the client comes back with the payment.
    const target = Math.ceil(requestedTarget / HOUR_MS) * HOUR_MS;
    if (target > meta.createdAt + x402.maxLifetimeSeconds * 1000) {
      throw new HttpError(400, `A link can live at most ${days(x402.maxLifetimeSeconds)} in total`);
    }
    const seconds = Math.ceil((target - paidFrom) / 1000);
    const requirements = requirementsFor(x402, priceFor(x402, seconds, meta.size));
    const header = req.headers[PAYMENT_SIGNATURE_HEADER];
    if (typeof header !== "string" || !header) throw paymentNeeded(x402, requirements, seconds);
    const payment = decodePayment(header);
    if (!matchesRequirements(payment, requirements)) {
      throw paymentNeeded(x402, requirements, seconds, "Payment does not match the price asked; pay the amount in this quote");
    }
    // One signed payment can only ever settle once, so never let it buy two extensions at once.
    const nonce = nonceOf(payment) ?? header;
    if (inFlight.has(nonce)) throw new HttpError(409, "This payment is already being used; wait for it to finish");
    if (inFlight.size >= MAX_PAYMENTS_IN_FLIGHT) throw tooManyRequests("Too many payments in progress; try again shortly", PAYMENT_BUSY_RETRY_MS);
    inFlight.add(nonce);
    try {
      const verified = await payments.facilitator.verify(payment, requirements);
      if (!verified.isValid) throw paymentNeeded(x402, requirements, seconds, verified.invalidReason ?? "Payment is not valid");
      return await settle(meta, target, payment, requirements, seconds, verified.payer, x402, payments);
    } finally {
      inFlight.delete(nonce);
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
