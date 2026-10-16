import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRequestError } from "viem";
import { describe, expect, it, vi } from "vitest";
import { openSqlite, SqliteSellerLedger } from "@zold/accept/sqlite";
import { acceptOptions, formatAmount, openPayments, paymentErrorReporter, priceFor, type LocalPayments } from "../src/x402.js";
import { loadX402Config, type SelfSettlement, type X402Config } from "../src/x402Config.js";

const PAY_TO = "0x" + "ab".repeat(20);
const GAS_KEY = `0x${"11".repeat(32)}`;
const DAY = 86_400;
const GIB = 1024 ** 3;
const ENV = { X402_PAY_TO: PAY_TO, X402_RPC_URL: "https://sepolia.example/v2/KEY", X402_GAS_PRIVATE_KEY: GAS_KEY };

const cfg = loadX402Config(ENV) as X402Config;

describe("loadX402Config", () => {
  it("is off unless a pay-to address is set", () => {
    expect(loadX402Config({})).toBeUndefined();
  });

  it("defaults to USDC on Base Sepolia, settled through the host's own RPC and gas key", () => {
    expect(cfg).toEqual({
      payTo: PAY_TO,
      network: "eip155:84532",
      chainId: 84532,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      assetDecimals: 6,
      assetSymbol: "USDC",
      settlement: { kind: "self", rpcUrl: "https://sepolia.example/v2/KEY", gasPrivateKey: GAS_KEY, maxGas: 150_000n, maxFeePerGas: 10_000_000_000n },
      pricePerFileMonth: 10_000,
      pricePerGbMonth: 20_000,
      maxLifetimeSeconds: 365 * DAY,
      maxTimeoutSeconds: 120,
    });
  });

  it("settles through a Zold hub when one is configured, with no gas key or RPC on this host", () => {
    const key = `zsk_${"k".repeat(32)}`;
    const hub = { X402_PAY_TO: PAY_TO, X402_HUB_URL: "https://hub.example/", X402_HUB_KEY: key };
    expect(loadX402Config(hub)?.settlement).toEqual({ kind: "hub", url: "https://hub.example", key });
    expect(loadX402Config({ ...hub, X402_HUB_URL: "http://localhost:8787" })?.settlement).toMatchObject({ url: "http://localhost:8787" });
    for (const url of ["http://hub.example", "https://hub.example/api", "not a url"]) {
      expect(() => loadX402Config({ ...hub, X402_HUB_URL: url })).toThrow(/X402_HUB_URL/);
    }
    expect(() => loadX402Config({ ...hub, X402_HUB_KEY: "wrongprefix-secretvalue" })).toThrow(/X402_HUB_KEY/);
    expect(() => loadX402Config({ ...hub, X402_HUB_KEY: "wrongprefix-secretvalue" })).not.toThrow(/secretvalue/);
    expect(() => loadX402Config({ ...hub, X402_HUB_KEY: undefined })).toThrow(/X402_HUB_KEY/);
  });

  it("treats blank values as unset, so a blanked variable switches modes cleanly", () => {
    const key = `zsk_${"k".repeat(32)}`;
    expect(loadX402Config({ ...ENV, X402_HUB_URL: "", X402_HUB_KEY: "" })?.settlement.kind).toBe("self");
    expect(loadX402Config({ X402_PAY_TO: PAY_TO, X402_HUB_URL: "https://hub.example", X402_HUB_KEY: key, X402_GAS_PRIVATE_KEY: "", X402_RPC_URL: "" })?.settlement.kind).toBe("hub");
    expect(loadX402Config({ X402_PAY_TO: "", X402_HUB_URL: "", X402_HUB_KEY: "", X402_GAS_PRIVATE_KEY: "", X402_RPC_URL: "" })).toBeUndefined();
  });

  it("refuses settlement variables without X402_PAY_TO, naming them but not their values", () => {
    for (const name of ["X402_HUB_URL", "X402_HUB_KEY", "X402_GAS_PRIVATE_KEY", "X402_RPC_URL"]) { // gitleaks:allow (variable names, no values)
      expect(() => loadX402Config({ [name]: "value-not-shown" })).toThrow(new RegExp(`${name} set without X402_PAY_TO`));
      expect(() => loadX402Config({ [name]: "value-not-shown" })).not.toThrow(/value-not-shown/);
    }
  });

  it("refuses payments with no way to settle them, or with both", () => {
    expect(() => loadX402Config({ X402_PAY_TO: PAY_TO })).toThrow(/needs a way to settle/);
    expect(() => loadX402Config({ X402_PAY_TO: PAY_TO, X402_HUB_KEY: `zsk_${"k".repeat(32)}` })).toThrow(/without X402_HUB_URL/);
    expect(() => loadX402Config({ ...ENV, X402_HUB_URL: "https://hub.example", X402_HUB_KEY: `zsk_${"k".repeat(32)}` })).toThrow(/not both/);
  });

  it("refuses every chain but Base Sepolia for now", () => {
    for (const network of ["eip155:8453", "eip155:1", "base"]) {
      expect(() => loadX402Config({ ...ENV, X402_NETWORK: network })).toThrow(/X402_NETWORK must be eip155:84532/);
    }
  });

  it("needs a valid pay-to address, RPC URL and gas key, without echoing secrets", () => {
    expect(() => loadX402Config({ ...ENV, X402_PAY_TO: "0x12" })).toThrow(/X402_PAY_TO/);
    expect(() => loadX402Config({ ...ENV, X402_PAY_TO: "0x" + "0".repeat(40) })).toThrow(/non-zero/);
    expect(() => loadX402Config({ ...ENV, X402_RPC_URL: undefined })).toThrow(/X402_RPC_URL/);
    expect(() => loadX402Config({ ...ENV, X402_RPC_URL: "wss://x/secret" })).toThrow(/X402_RPC_URL/);
    expect(() => loadX402Config({ ...ENV, X402_RPC_URL: "wss://x/secret" })).not.toThrow(/secret/);
    expect(() => loadX402Config({ ...ENV, X402_GAS_PRIVATE_KEY: undefined })).toThrow(/X402_GAS_PRIVATE_KEY/);
    expect(() => loadX402Config({ ...ENV, X402_GAS_PRIVATE_KEY: "0x1234" })).toThrow(/X402_GAS_PRIVATE_KEY/);
    expect(() => loadX402Config({ ...ENV, X402_GAS_PRIVATE_KEY: "0x1234" })).not.toThrow(/0x1234/);
  });

  it("takes gas and fee caps, and keeps offers within what @zold/accept allows", () => {
    expect(loadX402Config({ ...ENV, X402_MAX_GAS: "200000", X402_MAX_FEE_PER_GAS: "5" })).toMatchObject({ settlement: { maxGas: 200_000n, maxFeePerGas: 5n } });
    expect(() => loadX402Config({ ...ENV, X402_MAX_GAS: "-1" })).toThrow(/X402_MAX_GAS/);
    expect(() => loadX402Config({ ...ENV, X402_MAX_TIMEOUT_SECONDS: "300" })).toThrow(/X402_MAX_TIMEOUT_SECONDS must be an integer from 60 to 240/);
  });

  it("refuses to sell for nothing", () => {
    expect(() => loadX402Config({ ...ENV, X402_PRICE_PER_FILE_MONTH: "0", X402_PRICE_PER_GB_MONTH: "0" })).toThrow(/both be 0/);
  });
});

describe("x402 pricing and wiring", () => {
  it("charges per started 30 days, per file plus per GiB", () => {
    expect(priceFor(cfg, 1, 100)).toBe(10_001);
    expect(priceFor(cfg, 30 * DAY, GIB)).toBe(30_000);
    expect(priceFor(cfg, 30 * DAY + 1, GIB)).toBe(60_000);
    expect(priceFor(cfg, 90 * DAY, GIB / 2)).toBe(60_000);
  });

  it("formats atomic amounts as decimals", () => {
    expect(formatAmount(30_000, 6)).toBe("0.03");
    expect(formatAmount(1, 6)).toBe("0.000001");
    expect(formatAmount(2_500_000, 6)).toBe("2.5");
    expect(formatAmount(7, 0)).toBe("7");
  });

  it("names the public origin in offers only when it's https, and never prices on its own", () => {
    expect(acceptOptions(cfg, "https://shareme.lol")).toMatchObject({ publicOrigin: "https://shareme.lol", chainId: 84532, payTo: PAY_TO });
    expect(acceptOptions(cfg, "http://127.0.0.1:8080")).not.toHaveProperty("publicOrigin");
    expect(() => acceptOptions(cfg, "https://shareme.lol").price({ method: "POST", path: "/", headers: {} })).toThrow();
  });

  it("logs an RPC failure with its code, without the RPC URL's key or payer addresses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dir = await mkdtemp(join(tmpdir(), "share-x402-"));
    try {
      const rpcUrl = "https://sepolia.example/v2/SECRETKEY";
      const config = { ...cfg, settlement: { ...(cfg.settlement as SelfSettlement), rpcUrl } };
      const { acceptor } = openPayments(config, dir, "https://shareme.lol") as LocalPayments;
      // What viem throws when the RPC is down: its message carries the full URL. @zold/accept cuts it.
      const rpcDown = new HttpRequestError({ url: rpcUrl, details: "fetch failed", body: { method: "eth_blockNumber" } });
      expect(rpcDown.message).toContain("SECRETKEY");
      acceptor.reportError(rpcDown);
      paymentErrorReporter(config)(Object.assign(new Error(`payment share-me|84532|0xa|${PAY_TO}|0x1`), { code: "SETTLEMENT_UNKNOWN" }));
      const logged = log.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("payment HttpRequestError:");
      expect(logged).toContain("https://sepolia.example");
      expect(logged).toContain("payment SETTLEMENT_UNKNOWN:");
      for (const secret of ["SECRETKEY", "/v2/", PAY_TO]) expect(logged).not.toContain(secret);
    } finally {
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never logs the hub key", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const key = `zsk_${"s".repeat(32)}`;
    paymentErrorReporter({ ...cfg, settlement: { kind: "hub", url: "https://hub.example", key } })(new Error(`hub refused ${key}`));
    expect(log.mock.calls.join(" ")).toBe("[share-host] payment Error:,hub refused <redacted>");
    log.mockRestore();
  });

  it("never logs the gas key or RPC credentials, even outside a URL", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rpcUrl = "https://user:pw-secret-1@rpc.example/v3/PROJECTKEY123?apikey=QUERYKEY456";
    const config = { ...cfg, settlement: { ...(cfg.settlement as SelfSettlement), rpcUrl } };
    const report = paymentErrorReporter(config);
    report(new Error(`signer ${GAS_KEY} / ${GAS_KEY.slice(2).toUpperCase()} failed`));
    report(new Error("provider said: invalid project PROJECTKEY123, apikey=QUERYKEY456, auth pw-secret-1"));
    report(new Error(`raw ${rpcUrl} and path /v3/PROJECTKEY123`));
    const logged = log.mock.calls.map((c) => c.join(" ")).join("\n");
    for (const secret of [GAS_KEY.slice(2), "PROJECTKEY123", "QUERYKEY456", "pw-secret-1"]) expect(logged.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(logged).toContain("<redacted>");
    expect(logged).toContain("provider said: invalid project");
    log.mockRestore();
  });

  it("re-delivers paid extensions a 0.1 host marked delivered but never extended, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "share-x402-"));
    try {
      // A payments.db as a 0.1 host left it: one extension acknowledged, one lost to a crash, one still owed.
      const old = openSqlite(join(dir, "payments.db"));
      const legacy = new SqliteSellerLedger(old);
      const row = (n: number) => ({
        claimKey: `k${n}`, sellerAccountId: "share-me", protocol: "x402" as const, chainId: 84532, asset: cfg.asset, payer: PAY_TO,
        nonce: `0x${String(n).repeat(64)}`, amount: "10001", payTo: PAY_TO, validBefore: "1", method: "POST", path: "/api/files/extend",
        queryDigest: "q", headerDigest: `h${n}`, meta: { fileRef: `ref${n}`, until: "1" },
      });
      for (const n of [1, 2, 3]) await legacy.recordVerified(row(n));
      for (const n of [1, 2]) {
        await legacy.recordSettled(`k${n}`, `0x${"a".repeat(64)}`);
        await legacy.markDelivered(`k${n}`);
      }
      old.exec("CREATE TABLE share_extension_acks (claim_key TEXT PRIMARY KEY, at INTEGER NOT NULL) STRICT");
      old.prepare("INSERT INTO share_extension_acks VALUES ('k1', 1)").run();
      old.close();

      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { ledger } = openPayments(cfg, dir, "https://shareme.lol") as LocalPayments;
      expect((await ledger.undelivered()).map((r) => r.claimKey)).toEqual(["k2"]);
      expect(await ledger.get("k1")).toMatchObject({ delivered: true });
      expect(await ledger.get("k3")).toMatchObject({ status: "owed", delivered: false });
      expect(log.mock.calls.join(" ")).toContain("1 paid extension(s)");

      // The table is gone, so a second start changes nothing.
      openPayments(cfg, dir, "https://shareme.lol");
      expect((await ledger.undelivered()).map((r) => r.claimKey)).toEqual(["k2"]);
      expect(log).toHaveBeenCalledTimes(1);
      log.mockRestore();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("opens its stores in one SQLite file only this user can read, fixing an older readable one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "share-x402-"));
    try {
      await chmod(dir, 0o755);
      await writeFile(join(dir, "payments.db"), "", { mode: 0o644 });
      const { acceptor, ledger } = openPayments(cfg, dir, "https://shareme.lol") as LocalPayments;
      expect(typeof acceptor.handle).toBe("function");
      expect(await ledger.list()).toEqual([]);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      for (const file of ["payments.db", "payments.db-wal", "payments.db-shm"]) {
        expect((await stat(join(dir, file))).mode & 0o777, file).toBe(0o600);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
