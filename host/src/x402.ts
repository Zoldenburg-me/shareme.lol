import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { accept, viemChain, viemSubmitter, type AcceptDeps, type AcceptOptions, type Acceptor, type SellerLedgerPort } from "@zold/accept";
import { openSqlite, SqliteRateLimiter, SqliteSellerLedger, SqliteSingleUseStore } from "@zold/accept/sqlite";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { X402Config } from "./x402Config.js";

/** How this host takes payments: @zold/accept verifies, settles on chain itself and delivers once. */
export interface Payments {
  readonly acceptor: Acceptor;
  /** Payments are handled with deferDelivery, so a row is `delivered` only once its link was extended. */
  readonly ledger: SellerLedgerPort & Required<Pick<SellerLedgerPort, "undelivered">>;
  /** Ids of links with a payment request in flight here: the sweep keeps them. */
  readonly paying: Set<string>;
}

const MONTH_SECONDS = 30 * 86_400;
const GIBIBYTE = 1024 ** 3;
const DB_FILE = "payments.db";
// Settlements in flight at once, across all tokens; each polls the chain for up to SETTLEMENT_WAIT_MS.
const MAX_PAYMENTS_IN_FLIGHT = 8;
// How long a request waits for confirmations before answering "pending" (Base: ~2 s blocks, 2 confirmations).
// Kept well under the MCP client's extend timeout; the reconciler delivers whatever settles later.
export const SETTLEMENT_WAIT_MS = 20_000;
const ADDRESS = /0x[0-9a-fA-F]{40}/g;
// The ledger names payers next to what they paid for (personal data): owner-only, like tokens.json.
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

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
    settlementTimeoutMs: SETTLEMENT_WAIT_MS,
  };
}

/**
 * Where @zold/accept reports what no request is left to answer: the code and message, never the cause.
 * It cuts every URL (and so an RPC key) before this; payers' addresses (personal data) are masked here.
 */
export function reportPaymentError(error: unknown): void {
  const { code, message } = error as { code?: unknown; message?: unknown };
  const label = typeof code === "string" ? code : error instanceof Error ? error.name : "error";
  console.error(`[share-host] payment ${label}:`, String(message ?? error).replace(ADDRESS, "0x…"));
}

/** Opens <dataDir>/payments.db readable by this user only, its -wal and -shm included (SQLite copies the file's mode). */
function openPrivateDb(dataDir: string) {
  chmodSync(dataDir, PRIVATE_DIR);
  const path = join(dataDir, DB_FILE);
  closeSync(openSync(path, "a", PRIVATE_FILE));
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, PRIVATE_FILE);
  return openSqlite(path);
}

/** Production wiring: Base Sepolia over the configured RPC, every store in <dataDir>/payments.db. */
export function openPayments(config: X402Config, dataDir: string, publicBaseUrl: string): Payments {
  const transport = http(config.rpcUrl);
  const client = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ chain: baseSepolia, transport, account: privateKeyToAccount(config.gasPrivateKey) });
  const db = openPrivateDb(dataDir);
  const ledger = new SqliteSellerLedger(db);
  const deps: AcceptDeps = {
    ledger,
    claims: new SqliteSingleUseStore(db),
    rateLimiter: new SqliteRateLimiter(db),
    chain: viemChain({ client, chainId: config.chainId }),
    submitter: viemSubmitter({
      wallet, client, chainId: config.chainId, asset: config.asset, payTo: config.payTo, maxGas: config.maxGas, maxFeePerGas: config.maxFeePerGas,
    }),
    onError: reportPaymentError,
  };
  return { acceptor: accept(acceptOptions(config, publicBaseUrl), deps), ledger, paying: new Set() };
}
