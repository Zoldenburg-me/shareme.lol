import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decodePaymentSignature } from "agentpay-hub/protocol";

/** What a payment was first sent to the hub for: retries must send exactly this price, whatever the clock says. */
export interface HubRecord {
  readonly fileRef: string;
  readonly until: number;
  readonly amount: bigint;
  readonly delivered: boolean;
}

type Row = { file_ref: string; until: number; amount: string; delivered: number };

/**
 * The hub keeps the ledger; this host keeps only the price each payment was first sent at, so a retry of
 * the same payment (after a lost answer, an hour boundary or the link's expiry) is replayed by the hub
 * instead of refused. Keyed by a hash of payer and nonce: no wallet address is stored.
 */
export class HubPaymentRecords {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_payments (
      key TEXT PRIMARY KEY, file_ref TEXT NOT NULL, until INTEGER NOT NULL, amount TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  }

  /** The record key for a PAYMENT-SIGNATURE header, or undefined if it isn't an EIP-3009 x402 payment. */
  static keyOf(header: string): string | undefined {
    let auth: unknown;
    try {
      auth = decodePaymentSignature(header).payload.authorization;
    } catch {
      return undefined;
    }
    const { from, nonce } = (auth ?? {}) as { from?: unknown; nonce?: unknown };
    if (typeof from !== "string" || typeof nonce !== "string") return undefined;
    return createHash("sha256").update(`${from.toLowerCase()}:${nonce.toLowerCase()}`).digest("hex");
  }

  get(key: string): HubRecord | undefined {
    const row = this.db.prepare("SELECT file_ref, until, amount, delivered FROM hub_payments WHERE key = ?").get(key) as Row | undefined;
    return row && { fileRef: row.file_ref, until: Number(row.until), amount: BigInt(row.amount), delivered: row.delivered === 1 };
  }

  /** Records the price unless this payment already has one: the first price wins. It holds no file until `markHeld`. */
  remember(key: string, fileRef: string, until: number, amount: bigint, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO hub_payments (key, file_ref, until, amount, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, fileRef, until, amount.toString(), now);
  }

  /** The hub took the payment, or its outcome isn't known: keep this link until a retry delivers it. */
  markHeld(key: string, fileRef: string): void {
    this.db.prepare("UPDATE hub_payments SET held = 1 WHERE key = ? AND file_ref = ?").run(key, fileRef);
  }

  /** The hub refused this payment outright: forget it and release its link, unless it was delivered or is another link's. */
  forget(key: string, fileRef: string): void {
    this.db.prepare("DELETE FROM hub_payments WHERE key = ? AND file_ref = ? AND delivered = 0").run(key, fileRef);
  }

  markDelivered(key: string): void {
    this.db.prepare("UPDATE hub_payments SET delivered = 1 WHERE key = ?").run(key);
  }

  /** fileRefs of links whose payment the hub is settling but whose extension isn't confirmed here: the sweep keeps them. */
  undeliveredRefs(): Set<string> {
    const rows = this.db.prepare("SELECT file_ref FROM hub_payments WHERE delivered = 0 AND held = 1").all() as { file_ref: string }[];
    return new Set(rows.map((r) => r.file_ref));
  }

  /** Forgets records made before `before`: a retry after that is priced as a new extension. */
  prune(before: number): number {
    return Number(this.db.prepare("DELETE FROM hub_payments WHERE created_at < ?").run(before).changes);
  }
}
