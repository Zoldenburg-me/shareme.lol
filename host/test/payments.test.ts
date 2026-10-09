import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileRef, PaymentLedger, type PaymentRecord } from "../src/payments.js";

const record = (n: number): PaymentRecord => ({
  status: "settled", at: n, transaction: `0x${n}`, network: "eip155:8453", payer: "0xp", amount: "30000", asset: "0xa", fileRef: "f", owner: "tok_a", seconds: 60,
});

describe("PaymentLedger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-pay-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends one owner-readable JSON line per payment, keeping all of concurrent ones", async () => {
    const ledger = new PaymentLedger(dir);
    await Promise.all([1, 2, 3, 4, 5].map((n) => ledger.append(record(n))));
    const path = join(dir, "payments.jsonl");
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as PaymentRecord);
    expect(lines.map((l) => l.at).sort()).toEqual([1, 2, 3, 4, 5]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("refers to files by a short hash, never the secret id", () => {
    const ref = fileRef("A".repeat(22));
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(ref).toBe(fileRef("A".repeat(22)));
    expect(ref).not.toContain("AAAA");
  });
});
