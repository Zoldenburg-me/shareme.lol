import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
// Shorter URL parts ("v2", "rpc") aren't credentials, and masking them would garble messages.
const MIN_SECRET_LENGTH = 8;
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

/** The configured values that must never reach a log: the gas key (with and without 0x) and the RPC URL and its parts. */
function secretsOf(config: X402Config): string[] {
  const url = new URL(config.rpcUrl);
  const parts = [url.pathname, url.search.slice(1), url.username, url.password, ...url.pathname.split("/"), ...url.searchParams.values()];
  return [config.gasPrivateKey, config.gasPrivateKey.slice(2), config.rpcUrl, ...parts.filter((part) => part.length >= MIN_SECRET_LENGTH)];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where @zold/accept reports what no request is left to answer: the code and message, never the cause.
 * It cuts every URL first; this also removes the configured secrets wherever they appear outside a URL,
 * and masks payers' addresses (personal data).
 */
export function paymentErrorReporter(config: X402Config): (error: unknown) => void {
  // Longest first, so the whole RPC URL goes before its parts; hex keys may arrive in any case.
  const secrets = new RegExp([...new Set(secretsOf(config))].sort((x, y) => y.length - x.length).map(escapeRegExp).join("|"), "gi");
  return (error) => {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const label = typeof code === "string" ? code : error instanceof Error ? error.name : "error";
    console.error(`[share-host] payment ${label}:`, String(message ?? error).replace(secrets, "<redacted>").replace(ADDRESS, "0x…"));
  };
}

/**
 * A 0.1 host let @zold/accept mark a payment delivered before extending its link, and recorded the extension in
 * share_extension_acks. Settled rows marked delivered without an ack never got their extension: mark them
 * undelivered so the reconciler extends them (idempotent), then drop the table. Runs once, before any reconcile.
 */
export function migrateExtensionAcks(db: DatabaseSync): number {
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'share_extension_acks'").get();
  if (!legacy) return 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    // seller_payments is @zold/accept's SQLite ledger table (0.1 and 0.2 share its shape).
    const { changes } = db.prepare(`UPDATE seller_payments SET delivered = 0 WHERE status = 'settled' AND delivered = 1
      AND claim_key NOT IN (SELECT claim_key FROM share_extension_acks)`).run();
    db.exec("DROP TABLE share_extension_acks");
    db.exec("COMMIT");
    return Number(changes);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
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
  const reopened = migrateExtensionAcks(db);
  if (reopened > 0) console.log(`[share-host] ${reopened} paid extension(s) from before the upgrade will be delivered again`);
  const deps: AcceptDeps = {
    ledger,
    claims: new SqliteSingleUseStore(db),
    rateLimiter: new SqliteRateLimiter(db),
    chain: viemChain({ client, chainId: config.chainId }),
    submitter: viemSubmitter({
      wallet, client, chainId: config.chainId, asset: config.asset, payTo: config.payTo, maxGas: config.maxGas, maxFeePerGas: config.maxFeePerGas,
    }),
    onError: paymentErrorReporter(config),
  };
  return { acceptor: accept(acceptOptions(config, publicBaseUrl), deps), ledger, paying: new Set() };
}
