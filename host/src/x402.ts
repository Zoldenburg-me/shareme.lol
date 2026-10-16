import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  accept, viemChain, viemSubmitter, zoldSeller,
  type AcceptDeps, type AcceptOptions, type AcceptResult, type Acceptor, type Price, type ReqLike, type SellerLedgerPort,
} from "@zold/accept";
import { openSqlite, SqliteRateLimiter, SqliteSellerLedger, SqliteSingleUseStore } from "@zold/accept/sqlite";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { HubPaymentRecords } from "./hubRecords.js";
import type { HubSettlement, SelfSettlement, X402Config } from "./x402Config.js";

/** This host settles: @zold/accept verifies, settles on chain itself and delivers once. */
export interface LocalPayments {
  readonly mode: "local";
  readonly acceptor: Acceptor;
  /** Payments are handled with deferDelivery, so a row is `delivered` only once its link was extended. */
  readonly ledger: SellerLedgerPort & Required<Pick<SellerLedgerPort, "undelivered">>;
  /** Ids of links with a payment request in flight here: the sweep keeps them. */
  readonly paying: Set<string>;
}

/**
 * A Zold hub settles and keeps the ledger. This host keeps only the price each payment was first sent at
 * (HubPaymentRecords), so a retry of the same payment is replayed by the hub at that price.
 */
export interface HubPayments {
  readonly mode: "hub";
  /** One request to the hub at its price; undefined when MAX_PAYMENTS_IN_FLIGHT are already out. */
  readonly settle: (req: ReqLike, price: Price) => Promise<AcceptResult | undefined>;
  readonly records: HubPaymentRecords;
  /** The ledger from when this host settled itself, if payments.db has one: its settled rows still need delivering. */
  readonly legacy?: LocalPayments["ledger"];
  readonly reportError: (error: unknown) => void;
  readonly paying: Set<string>;
}

export type Payments = LocalPayments | HubPayments;

const MONTH_SECONDS = 30 * 86_400;
const GIBIBYTE = 1024 ** 3;
const DB_FILE = "payments.db";
// Settlements in flight at once, across all tokens; each polls the chain for up to SETTLEMENT_WAIT_MS.
const MAX_PAYMENTS_IN_FLIGHT = 8;
// How long a request waits for confirmations before answering "pending" (Base: ~2 s blocks, 2 confirmations).
// Kept well under the MCP client's extend timeout; the reconciler delivers whatever settles later.
export const SETTLEMENT_WAIT_MS = 20_000;
// How long a request waits for the hub: under the MCP client's 90 s extend timeout and Cloudflare's 100 s.
const HUB_TIMEOUT_MS = 25_000;
/** How long a payment sent to a hub can be retried at its first price; the sweep prunes older records. */
export const HUB_RECORD_DAYS = 30;
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

/** The configured values that must never reach a log: the gas key (with and without 0x) and the RPC URL and its parts, or the hub key. */
function secretsOf(config: X402Config): string[] {
  const s = config.settlement;
  if (s.kind === "hub") return [s.key];
  const url = new URL(s.rpcUrl);
  const parts = [url.pathname, url.search.slice(1), url.username, url.password, ...url.pathname.split("/"), ...url.searchParams.values()];
  return [s.gasPrivateKey, s.gasPrivateKey.slice(2), s.rpcUrl, ...parts.filter((part) => part.length >= MIN_SECRET_LENGTH)];
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

/** Hosted settlement: every paid request goes to the hub's POST /api/agent-payments/settle. */
export function openHubPayments(config: X402Config, hub: HubSettlement, dataDir: string, fetchImpl?: typeof fetch): HubPayments {
  const onError = paymentErrorReporter(config);
  // zoldSeller prices from headers only, and extensions are priced per link: one per request, at its price.
  const sellerFor = (price: Price) => zoldSeller({
    apiUrl: hub.url, apiKey: hub.key, price: () => price, onError, timeoutMs: HUB_TIMEOUT_MS, ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  sellerFor({ amount: 1n }); // zoldSeller checks its options when made: fail at startup, not on the first payment
  let inFlight = 0;
  const settle = async (req: ReqLike, price: Price) => {
    if (inFlight >= MAX_PAYMENTS_IN_FLIGHT) return undefined;
    inFlight += 1;
    try {
      return await sellerFor(price).handle(req);
    } finally {
      inFlight -= 1;
    }
  };
  const db = openPrivateDb(dataDir);
  const hadLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seller_payments'").get() !== undefined;
  if (hadLedger) migrateExtensionAcks(db);
  return {
    mode: "hub", settle, records: new HubPaymentRecords(db), reportError: onError, paying: new Set(),
    ...(hadLedger ? { legacy: new SqliteSellerLedger(db) } : {}),
  };
}

/**
 * Refuses to run a hub while payments this host started settling itself are unresolved: only this host's
 * own gas key and RPC can finish them. Settled-but-undelivered rows are fine; createLegacyDelivery does those.
 */
export async function assertNoOpenLegacy(payments: HubPayments): Promise<void> {
  const open = ((await payments.legacy?.list()) ?? []).filter((row) => row.status === "owed" || row.status === "submitted");
  if (open.length === 0) return;
  throw new Error(`payments.db holds ${open.length} payment(s) this host is still settling itself. ` +
    "Run once more with X402_GAS_PRIVATE_KEY and X402_RPC_URL (no hub) until the log shows them reconciled, then switch to X402_HUB_URL");
}

/** Production wiring: a hub if one is configured, else Base Sepolia over the configured RPC with every store in <dataDir>/payments.db. */
export function openPayments(config: X402Config, dataDir: string, publicBaseUrl: string): Payments {
  const s = config.settlement;
  return s.kind === "hub" ? openHubPayments(config, s, dataDir) : openLocalPayments(config, s, dataDir, publicBaseUrl);
}

function openLocalPayments(config: X402Config, s: SelfSettlement, dataDir: string, publicBaseUrl: string): LocalPayments {
  const transport = http(s.rpcUrl);
  const client = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ chain: baseSepolia, transport, account: privateKeyToAccount(s.gasPrivateKey) });
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
      wallet, client, chainId: config.chainId, asset: config.asset, payTo: config.payTo, maxGas: s.maxGas, maxFeePerGas: s.maxFeePerGas,
    }),
    onError: paymentErrorReporter(config),
  };
  return { mode: "local", acceptor: accept(acceptOptions(config, publicBaseUrl), deps), ledger, paying: new Set() };
}
