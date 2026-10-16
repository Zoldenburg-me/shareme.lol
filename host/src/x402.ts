import { join } from "node:path";
import { accept, viemChain, viemSubmitter, type AcceptDeps, type AcceptOptions, type Acceptor } from "@zold/accept";
import { openSqlite, SqliteRateLimiter, SqliteSellerLedger, SqliteSingleUseStore } from "@zold/accept/sqlite";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { X402Config } from "./x402Config.js";

/** How this host takes payments: @zold/accept verifies, settles on chain itself and delivers once. */
export interface Payments {
  readonly acceptor: Acceptor;
}

const MONTH_SECONDS = 30 * 86_400;
const GIBIBYTE = 1024 ** 3;
const DB_FILE = "payments.db";
// Settlements in flight at once, across all tokens; each polls the chain for up to a minute.
const MAX_PAYMENTS_IN_FLIGHT = 8;
const ADDRESS = /0x[0-9a-fA-F]{40}/g;

/** Atomic units for `seconds` of extra life on a file of `size` bytes: per started 30 days. */
export function priceFor(config: X402Config, seconds: number, size: number): number {
  const months = Math.ceil(seconds / MONTH_SECONDS);
  return months * (config.pricePerFileMonth + Math.ceil((config.pricePerGbMonth * size) / GIBIBYTE));
}

export function formatAmount(amount: number, decimals: number): string {
  if (decimals === 0) return String(amount);
  const digits = String(amount).padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

/** The accept() options for this host. Every request is priced by the extender, so `price` is never used. */
export function acceptOptions(config: X402Config, publicBaseUrl: string): AcceptOptions {
  const origin = new URL(publicBaseUrl);
  return {
    sellerAccountId: "share-me",
    payTo: config.payTo,
    chainId: config.chainId,
    asset: config.asset,
    price: () => {
      throw new Error("extensions are priced per request");
    },
    // The offer's resource URL; @zold/accept only takes an https origin.
    ...(origin.protocol === "https:" ? { publicOrigin: origin.origin } : {}),
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    maxInFlight: MAX_PAYMENTS_IN_FLIGHT,
  };
}

/**
 * Where @zold/accept reports what no request is left to answer. Only the code and message: the
 * cause may hold the RPC URL (and its key), and messages name payers' addresses (personal data).
 */
export function reportPaymentError(error: unknown): void {
  const { code, message } = error as { code?: string; message?: string };
  console.error(`[share-host] payment ${code ?? "error"}:`, String(message ?? error).replace(ADDRESS, "0x…"));
}

/** Production wiring: Base Sepolia over the configured RPC, every store in <dataDir>/payments.db. */
export function openPayments(config: X402Config, dataDir: string, publicBaseUrl: string): Payments {
  const transport = http(config.rpcUrl);
  const client = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ chain: baseSepolia, transport, account: privateKeyToAccount(config.gasPrivateKey) });
  const db = openSqlite(join(dataDir, DB_FILE));
  const deps: AcceptDeps = {
    ledger: new SqliteSellerLedger(db),
    claims: new SqliteSingleUseStore(db),
    rateLimiter: new SqliteRateLimiter(db),
    chain: viemChain({ client, chainId: config.chainId }),
    submitter: viemSubmitter({
      wallet, client, chainId: config.chainId, asset: config.asset, payTo: config.payTo, maxGas: config.maxGas, maxFeePerGas: config.maxFeePerGas,
    }),
    onError: reportPaymentError,
  };
  return { acceptor: accept(acceptOptions(config, publicBaseUrl), deps) };
}
