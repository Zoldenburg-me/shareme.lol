import { HttpError } from "./http.js";
import type { X402Config } from "./x402Config.js";

// x402 v2: the 402 carries PAYMENT-REQUIRED, the client retries with PAYMENT-SIGNATURE, and the
// facilitator's /verify and /settle check the signed EIP-3009 transfer and put it on chain.
export const X402_VERSION = 2;
export const PAYMENT_REQUIRED_HEADER = "payment-required";
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_RESPONSE_HEADER = "payment-response";

export interface PaymentRequirements {
  readonly scheme: "exact";
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: { readonly name: string; readonly version: string };
}

export interface PaymentPayload {
  readonly x402Version: number;
  readonly accepted: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

export interface VerifyResponse {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly payer?: string;
}

export interface SettleResponse {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly payer?: string;
  readonly transaction: string;
  readonly network: string;
}

export interface Facilitator {
  verify(payment: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

const MONTH_SECONDS = 30 * 86_400;
const GIBIBYTE = 1024 ** 3;
// A v2 payload is a few hundred bytes; anything far bigger is not one.
const MAX_HEADER_LENGTH = 16_384;
const FACILITATOR_TIMEOUT_MS = 30_000;

/** Atomic units for `seconds` of extra life on a file of `size` bytes: per started 30 days. */
export function priceFor(config: X402Config, seconds: number, size: number): number {
  const months = Math.ceil(seconds / MONTH_SECONDS);
  return months * (config.pricePerFileMonth + Math.ceil((config.pricePerGbMonth * size) / GIBIBYTE));
}

export function requirementsFor(config: X402Config, amount: number): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network,
    amount: String(amount),
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: { name: config.assetName, version: config.assetVersion },
  };
}

export function paymentRequired(resourceUrl: string, description: string, requirements: PaymentRequirements, error?: string) {
  return {
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    accepts: [requirements],
  };
}

export function formatAmount(amount: number, decimals: number): string {
  if (decimals === 0) return String(amount);
  const digits = String(amount).padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

export const encodeHeader = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function decodePayment(header: string): PaymentPayload {
  const invalid = new HttpError(400, "PAYMENT-SIGNATURE must be a base64-encoded x402 v2 payment payload");
  if (header.length > MAX_HEADER_LENGTH) throw invalid;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw invalid;
  }
  if (!isObject(value) || value.x402Version !== X402_VERSION || !isObject(value.accepted) || !isObject(value.payload)) throw invalid;
  return value as unknown as PaymentPayload;
}

/** Whether the client signed for exactly what we asked. The facilitator checks the signature itself. */
export function matchesRequirements(payment: PaymentPayload, requirements: PaymentRequirements): boolean {
  const a = payment.accepted;
  return a.scheme === requirements.scheme && a.network === requirements.network && a.amount === requirements.amount &&
    typeof a.asset === "string" && a.asset.toLowerCase() === requirements.asset.toLowerCase() &&
    typeof a.payTo === "string" && a.payTo.toLowerCase() === requirements.payTo.toLowerCase();
}

/** A facilitator reached over HTTP (POST <url>/verify and <url>/settle). */
export function httpFacilitator(url: string, auth?: string, fetchImpl: typeof fetch = fetch): Facilitator {
  async function call(path: "verify" | "settle", payment: PaymentPayload, requirements: PaymentRequirements): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchImpl(`${url}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirements }),
        signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`[share-host] payment facilitator ${path} unreachable:`, (err as Error).message);
      throw new HttpError(502, "The payment service is unreachable; try again shortly");
    }
    const body: unknown = await res.json().catch(() => undefined);
    // A 400 with a well-formed answer is how facilitators report an invalid payment.
    if ((res.ok || res.status === 400) && isObject(body)) return body;
    console.error(`[share-host] payment facilitator ${path} answered ${res.status}`);
    throw new HttpError(502, "The payment service failed; try again shortly");
  }

  const malformed = (path: string) => {
    console.error(`[share-host] payment facilitator ${path} sent an unexpected answer`);
    return new HttpError(502, "The payment service failed; try again shortly");
  };

  return {
    async verify(payment, requirements) {
      const body = await call("verify", payment, requirements);
      if (typeof body.isValid !== "boolean") throw malformed("verify");
      return body as unknown as VerifyResponse;
    },
    async settle(payment, requirements) {
      const body = await call("settle", payment, requirements);
      if (typeof body.success !== "boolean") throw malformed("settle");
      return body as unknown as SettleResponse;
    },
  };
}
