import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acceptOptions, formatAmount, openPayments, priceFor, reportPaymentError } from "../src/x402.js";
import { loadX402Config, type X402Config } from "../src/x402Config.js";

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
      rpcUrl: "https://sepolia.example/v2/KEY",
      gasPrivateKey: GAS_KEY,
      maxGas: 150_000n,
      maxFeePerGas: 10_000_000_000n,
      pricePerFileMonth: 10_000,
      pricePerGbMonth: 20_000,
      maxLifetimeSeconds: 365 * DAY,
      maxTimeoutSeconds: 120,
    });
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
    expect(loadX402Config({ ...ENV, X402_MAX_GAS: "200000", X402_MAX_FEE_PER_GAS: "5" })).toMatchObject({ maxGas: 200_000n, maxFeePerGas: 5n });
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

  it("logs payment errors without payer addresses", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportPaymentError(Object.assign(new Error(`payment share-me|84532|0xa|${PAY_TO}|0x1: SETTLEMENT_UNKNOWN`), { code: "SETTLEMENT_UNKNOWN" }));
    expect(log.mock.calls[0].join(" ")).toMatch(/SETTLEMENT_UNKNOWN/);
    expect(log.mock.calls[0].join(" ")).not.toContain(PAY_TO);
    log.mockRestore();
  });

  it("opens its stores in one SQLite file under the data dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "share-x402-"));
    try {
      const { acceptor } = openPayments(cfg, dir, "https://shareme.lol");
      expect(typeof acceptor.handle).toBe("function");
      expect((await stat(join(dir, "payments.db"))).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
