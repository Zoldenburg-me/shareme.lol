import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

/** One payment. The payer's address is personal data (linked to `owner`); keep the file mode 600. */
export interface PaymentRecord {
  /** "pending": the facilitator's answer was lost, so the money may or may not have moved; reconcile by hand. */
  readonly status: "settled" | "pending";
  readonly at: number;
  readonly transaction: string;
  /** The EIP-3009 nonce, which identifies the transfer on chain even when the transaction hash is unknown. */
  readonly nonce?: string;
  readonly network: string;
  readonly payer?: string;
  /** Atomic units of `asset`. */
  readonly amount: string;
  readonly asset: string;
  /** sha256 of the file id, cut to 16 hex: enough to match a live file, useless as a link. */
  readonly fileRef: string;
  readonly owner?: string;
  /** Extra life bought, in seconds. */
  readonly seconds: number;
}

const FILE = "payments.jsonl";
const FILE_REF_LENGTH = 16;

/** The ledger's stand-in for a file id, which is a bearer secret and must outlive no file. */
export const fileRef = (fileId: string): string => createHash("sha256").update(fileId).digest("hex").slice(0, FILE_REF_LENGTH);

/** Append-only record of payments taken (<dataDir>/payments.jsonl, mode 600). */
export class PaymentLedger {
  private readonly path: string;
  // Appends are chained so concurrent payments never interleave a line.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, FILE);
  }

  append(record: PaymentRecord): Promise<void> {
    const run = this.queue.then(() => appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 }));
    this.queue = run.catch(() => undefined);
    return run;
  }
}
