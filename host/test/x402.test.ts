import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/http.js";
import {
  decodePayment, encodeHeader, formatAmount, httpFacilitator, matchesRequirements, paymentRequired, priceFor, requirementsFor,
} from "../src/x402.js";
import { loadX402Config, type X402Config } from "../src/x402Config.js";

const PAY_TO = "0x" + "ab".repeat(20);
const DAY = 86_400;
const GIB = 1024 ** 3;

const cfg: X402Config = {
  payTo: PAY_TO,
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  assetName: "USDC",
  assetVersion: "2",
  assetDecimals: 6,
  assetSymbol: "USDC",
  facilitatorUrl: "https://pay.example.com/x402",
  pricePerFileMonth: 10_000,
  pricePerGbMonth: 20_000,
  maxLifetimeSeconds: 365 * DAY,
  maxTimeoutSeconds: 120,
};

const payloadFor = (reqs: ReturnType<typeof requirementsFor>) => ({
  x402Version: 2,
  accepted: reqs,
  payload: { signature: "0xsig", authorization: { from: "0x1", to: PAY_TO, value: reqs.amount, validAfter: "0", validBefore: "9", nonce: "0x2" } },
});

describe("loadX402Config", () => {
  it("is off unless a pay-to address is set", () => {
    expect(loadX402Config({})).toBeUndefined();
  });

  it("needs a facilitator URL and a valid address", () => {
    expect(() => loadX402Config({ X402_PAY_TO: PAY_TO })).toThrow(/X402_FACILITATOR_URL/);
    expect(() => loadX402Config({ X402_PAY_TO: "0x12", X402_FACILITATOR_URL: "https://f.example" })).toThrow(/X402_PAY_TO/);
    expect(() => loadX402Config({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: "ftp://f" })).toThrow(/X402_FACILITATOR_URL/);
  });

  it("defaults to USDC on Base mainnet with its EIP-712 domain", () => {
    expect(loadX402Config({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: "https://f.example/x402/" })).toEqual({
      payTo: PAY_TO,
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      assetName: "USD Coin",
      assetVersion: "2",
      assetDecimals: 6,
      assetSymbol: "USDC",
      facilitatorUrl: "https://f.example/x402",
      pricePerFileMonth: 10_000,
      pricePerGbMonth: 20_000,
      maxLifetimeSeconds: 365 * DAY,
      maxTimeoutSeconds: 120,
    });
  });

  it("knows USDC on Base Sepolia and keeps the facilitator credential", () => {
    const c = loadX402Config({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: "https://f.example", X402_NETWORK: "eip155:84532", X402_FACILITATOR_AUTH: "Bearer k" });
    expect(c).toMatchObject({ asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", assetName: "USDC", facilitatorAuth: "Bearer k" });
  });

  it("refuses to sell for nothing", () => {
    expect(() => loadX402Config({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: "https://f.example", X402_PRICE_PER_FILE_MONTH: "0", X402_PRICE_PER_GB_MONTH: "0" })).toThrow(/both be 0/);
  });

  it("needs the asset spelled out on networks it doesn't know", () => {
    const env = { X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: "https://f.example", X402_NETWORK: "eip155:10" };
    expect(() => loadX402Config(env)).toThrow(/X402_ASSET/);
    expect(loadX402Config({ ...env, X402_ASSET: PAY_TO, X402_ASSET_NAME: "USD Coin", X402_ASSET_VERSION: "2" })).toMatchObject({ network: "eip155:10", asset: PAY_TO });
    expect(() => loadX402Config({ ...env, X402_NETWORK: "base" })).toThrow(/CAIP-2/);
  });
});

describe("x402 pricing and messages", () => {
  it("charges per started 30 days, per file plus per GiB", () => {
    expect(priceFor(cfg, 1, 100)).toBe(10_001);
    expect(priceFor(cfg, 30 * DAY, GIB)).toBe(30_000);
    expect(priceFor(cfg, 30 * DAY + 1, GIB)).toBe(60_000);
    expect(priceFor(cfg, 90 * DAY, GIB / 2)).toBe(60_000);
  });

  it("builds exact-scheme requirements with the token's EIP-712 domain", () => {
    expect(requirementsFor(cfg, 12_345)).toEqual({
      scheme: "exact",
      network: "eip155:84532",
      amount: "12345",
      asset: cfg.asset,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      extra: { name: "USDC", version: "2" },
    });
  });

  it("describes what is being paid for without naming the link", () => {
    const reqs = requirementsFor(cfg, 1);
    expect(paymentRequired("https://h/api/files/extend", "Keep a link 30 more days", reqs, "missing")).toEqual({
      x402Version: 2,
      error: "missing",
      resource: { url: "https://h/api/files/extend", description: "Keep a link 30 more days", mimeType: "application/json" },
      accepts: [reqs],
    });
  });

  it("formats atomic amounts as decimals", () => {
    expect(formatAmount(30_000, 6)).toBe("0.03");
    expect(formatAmount(1, 6)).toBe("0.000001");
    expect(formatAmount(2_500_000, 6)).toBe("2.5");
    expect(formatAmount(7, 0)).toBe("7");
  });

  it("round-trips a payment through its header and checks it against the requirements", () => {
    const reqs = requirementsFor(cfg, 30_000);
    const decoded = decodePayment(encodeHeader(payloadFor(reqs)));
    expect(matchesRequirements(decoded, reqs)).toBe(true);
    expect(matchesRequirements(decodePayment(encodeHeader(payloadFor(requirementsFor(cfg, 1)))), reqs)).toBe(false);
    expect(matchesRequirements({ ...decoded, accepted: { ...reqs, payTo: "0x" + "cd".repeat(20) } }, reqs)).toBe(false);
  });

  it("rejects payment headers that aren't x402 v2 payloads", () => {
    for (const bad of ["%%%", Buffer.from("[]").toString("base64"), encodeHeader({ x402Version: 1, accepted: {}, payload: {} }), encodeHeader({ x402Version: 2 }), "x".repeat(20_000)]) {
      expect(() => decodePayment(bad)).toThrow(HttpError);
    }
  });
});

describe("httpFacilitator", () => {
  const reqs = requirementsFor(cfg, 30_000);
  const payment = payloadFor(reqs);

  it("posts payment and requirements to /verify and /settle with its credential", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      Response.json(String(url).endsWith("/verify") ? { isValid: true, payer: "0x1" } : { success: true, transaction: "0xtx", network: cfg.network }));
    const f = httpFacilitator(cfg.facilitatorUrl, "Bearer k", fetchImpl as typeof fetch);

    expect(await f.verify(payment, reqs)).toEqual({ isValid: true, payer: "0x1" });
    expect(await f.settle(payment, reqs)).toEqual({ success: true, transaction: "0xtx", network: cfg.network });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://pay.example.com/x402/verify");
    expect(init.headers).toMatchObject({ authorization: "Bearer k", "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ x402Version: 2, paymentPayload: payment, paymentRequirements: reqs });
  });

  it("turns facilitator outages and bad answers into 502s", async () => {
    const down = httpFacilitator(cfg.facilitatorUrl, undefined, (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch);
    await expect(down.verify(payment, reqs)).rejects.toMatchObject({ status: 502 });
    const broken = httpFacilitator(cfg.facilitatorUrl, undefined, (async () => new Response("nope", { status: 500 })) as typeof fetch);
    await expect(broken.settle(payment, reqs)).rejects.toMatchObject({ status: 502 });
    const garbled = httpFacilitator(cfg.facilitatorUrl, undefined, (async () => Response.json({ hello: 1 })) as typeof fetch);
    await expect(garbled.verify(payment, reqs)).rejects.toMatchObject({ status: 502 });
  });
});
