import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/app.js";
import type { HostConfig } from "../src/config.js";
import { HttpError } from "../src/http.js";
import { fileRef, PaymentLedger } from "../src/payments.js";
import { SignupLimiter } from "../src/signupLimiter.js";
import { FileStore } from "../src/store.js";
import { TokenStore } from "../src/tokens.js";
import { encodeHeader, requirementsFor, type Facilitator, type PaymentRequirements } from "../src/x402.js";
import type { X402Config } from "../src/x402Config.js";

const ADMIN = "a".repeat(40);
const DAY = 86_400;
const DAY_MS = DAY * 1000;
const PAY_TO = "0x" + "ab".repeat(20);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const X402: X402Config = {
  payTo: PAY_TO,
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  assetName: "USDC",
  assetVersion: "2",
  assetDecimals: 6,
  assetSymbol: "USDC",
  facilitatorUrl: "https://pay.example.com",
  pricePerFileMonth: 10_000,
  pricePerGbMonth: 20_000,
  maxLifetimeSeconds: 365 * DAY,
  maxTimeoutSeconds: 120,
};

const signed = (reqs: PaymentRequirements) =>
  encodeHeader({ x402Version: 2, accepted: reqs, payload: { signature: "0xsig", authorization: { value: reqs.amount, nonce: "0x1" } } });
const decode = (header: string | null) => JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8"));

describe("extending links and paying with x402", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let clock: number;
  let tokens: TokenStore;
  let facilitator: { verify: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn> };

  const start = async (overrides: Partial<HostConfig> = {}) => {
    const config: HostConfig = {
      apiToken: ADMIN,
      publicBaseUrl: "https://shareme.lol",
      dataDir: dir,
      port: 0,
      defaultTtlSeconds: DAY,
      maxTtlSeconds: 7 * DAY,
      maxFileBytes: 1000,
      landingPage: "site/index.html",
      maxTotalBytes: 100_000,
      sweepIntervalMs: 60_000,
      allowedExtensions: ["md", "txt"],
      openSignup: true,
      tokenQuotaBytes: 100,
      signupsPerIpPerHour: 100,
      signupsPerDay: 1000,
      trustCfConnectingIp: true,
      apiRequestsPerIpPerMinute: 1000,
      authFailuresPerIpPerHour: 30,
      uploadsPerTokenPerHour: 60,
      downloadsPerIpPerMinute: 300,
      shortLinkMissesPerIpPerHour: 60,
      maxFilesPerToken: 2,
      concurrentUploadsPerToken: 2,
      minUploadBytesPerSecond: 1,
      uploadPaceWindowMs: 10_000,
      pro: { maxTtlSeconds: 90 * DAY, quotaBytes: 500, maxFiles: 5 },
      x402: X402,
      ...overrides,
    };
    tokens = await TokenStore.open(dir);
    server = createServer(config, await FileStore.open(dir), () => clock, undefined,
      { tokens, limiter: new SignupLimiter(100, 1000) },
      { facilitator: facilitator as unknown as Facilitator, ledger: new PaymentLedger(dir) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  const newToken = async () => (await (await fetch(`${base}/api/tokens`, { method: "POST" })).json()) as { token: string; id: string };
  const upload = async (token: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/files`, { method: "POST", headers: { ...bearer(token), "x-filename": "a.md", ...headers }, body: "hello" });
  const extend = (token: string, id: string, ttlSeconds: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/files/${id}/extend`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json", ...headers }, body: JSON.stringify({ ttlSeconds }) });
  const setPlan = (token: string, id: string, until: string | null) =>
    fetch(`${base}/api/tokens/${id}/plan`, { method: "PUT", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify({ until }) });
  // What the host charges for extending a 5-byte file by up to 30 days past the free limit.
  const oneMonth = () => requirementsFor(X402, 10_001);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-extend-"));
    clock = Date.parse("2026-10-09T12:00:00Z");
    facilitator = {
      verify: vi.fn(async () => ({ isValid: true, payer: "0xpayer" })),
      settle: vi.fn(async () => ({ success: true, transaction: "0xtx", network: X402.network, payer: "0xpayer" })),
    };
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("says when an upload's TTL was capped, and by what", async () => {
    await start();
    const { token } = await newToken();
    const capped = await (await upload(token, { "x-ttl-seconds": String(30 * DAY) })).json();
    expect(capped).toMatchObject({ ttlCapped: true, requestedTtlSeconds: 30 * DAY, maxTtlSeconds: 7 * DAY, expiresAt: new Date(clock + 7 * DAY_MS).toISOString() });
    const fine = await (await upload(token, { "x-ttl-seconds": "60" })).json();
    expect(fine).not.toHaveProperty("ttlCapped");
  });

  it("extends a link for free up to the plan's limit, never shortening it", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    clock += DAY_MS / 2;

    const res = await extend(token, id, 6 * DAY);
    expect(res.status).toBe(200);
    expect((await res.json()).expiresAt).toBe(new Date(clock + 6 * DAY_MS).toISOString());

    const shorter = await (await extend(token, id, 60)).json();
    expect(shorter.expiresAt).toBe(new Date(clock + 6 * DAY_MS).toISOString());
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("only lets a token extend its own links, with a valid ttl", async () => {
    await start();
    const a = await newToken();
    const b = await newToken();
    const { id } = await (await upload(a.token)).json();
    expect((await extend(b.token, id, 60)).status).toBe(404);
    expect((await extend(a.token, "A".repeat(22), 60)).status).toBe(404);
    for (const bad of [0, -1, 1.5, "60", null]) expect((await extend(a.token, id, bad)).status).toBe(400);
    const garbage = await fetch(`${base}/api/files/${id}/extend`, { method: "POST", headers: bearer(a.token), body: "{" });
    expect(garbage.status).toBe(400);
    expect((await fetch(`${base}/api/files/${id}/extend`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("asks for an x402 payment past the plan's limit, without putting the link in the request", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();

    const res = await extend(token, id, 30 * DAY);
    expect(res.status).toBe(402);
    const required = decode(res.headers.get("payment-required"));
    expect(required).toMatchObject({ x402Version: 2, resource: { url: "https://shareme.lol/api/files/extend" }, accepts: [oneMonth()] });
    expect(JSON.stringify(required)).not.toContain(id);
    expect(await res.json()).toMatchObject({ price: "0.010001", currency: "USDC", paymentRequired: required });
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("refuses to extend past the longest lifetime the host sells", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    expect((await extend(token, id, 366 * DAY)).status).toBe(400);
  });

  it("says payments are unavailable on a host without x402", async () => {
    await start({ x402: undefined });
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    const res = await extend(token, id, 30 * DAY);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/7 days/);
  });

  it("extends a link once the payment verifies and settles, and records it", async () => {
    await start();
    const { token, id: owner } = await newToken();
    const { id } = await (await upload(token)).json();

    const res = await extend(token, id, 30 * DAY, { "payment-signature": signed(oneMonth()) });
    expect(res.status).toBe(200);
    expect((await res.json()).expiresAt).toBe(new Date(clock + 30 * DAY_MS).toISOString());
    expect(decode(res.headers.get("payment-response"))).toMatchObject({ success: true, transaction: "0xtx" });
    expect(facilitator.verify.mock.calls[0][1]).toEqual(oneMonth());
    expect(facilitator.settle).toHaveBeenCalledTimes(1);

    const raw = await readFile(join(dir, "payments.jsonl"), "utf8");
    expect(raw).not.toContain(id);
    const ledger = JSON.parse(raw);
    expect(ledger).toMatchObject({ transaction: "0xtx", payer: "0xpayer", amount: "10001", fileRef: fileRef(id), owner, seconds: 23 * DAY });
  });

  it("only charges for time past what the link already has", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    await extend(token, id, 30 * DAY, { "payment-signature": signed(oneMonth()) });

    // Already paid through day 30; 40 days out needs one more started month.
    const res = await extend(token, id, 40 * DAY);
    expect(decode(res.headers.get("payment-required")).accepts[0].amount).toBe("10001");
  });

  it("rejects a payment signed for a different amount without asking the facilitator", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    const res = await extend(token, id, 30 * DAY, { "payment-signature": signed(requirementsFor(X402, 1)) });
    expect(res.status).toBe(402);
    expect(decode(res.headers.get("payment-required")).error).toMatch(/does not match/);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect((await extend(token, id, 30 * DAY, { "payment-signature": "%%%" })).status).toBe(400);
  });

  it("leaves the link alone when the payment doesn't verify", async () => {
    await start();
    facilitator.verify.mockResolvedValueOnce({ isValid: false, invalidReason: "insufficient_funds" });
    const { token } = await newToken();
    const { id, expiresAt } = await (await upload(token)).json();
    const res = await extend(token, id, 30 * DAY, { "payment-signature": signed(oneMonth()) });
    expect(res.status).toBe(402);
    expect(decode(res.headers.get("payment-required")).error).toBe("insufficient_funds");
    expect(facilitator.settle).not.toHaveBeenCalled();
    const files = (await (await fetch(`${base}/api/files`, { headers: bearer(token) })).json()).files;
    expect(files[0].expiresAt).toBe(expiresAt);
  });

  it("undoes the extension when settlement fails", async () => {
    await start();
    facilitator.settle.mockResolvedValueOnce({ success: false, errorReason: "nonce_used", transaction: "", network: X402.network });
    const { token } = await newToken();
    const { id, expiresAt } = await (await upload(token)).json();
    const res = await extend(token, id, 30 * DAY, { "payment-signature": signed(oneMonth()) });
    expect(res.status).toBe(402);
    expect(decode(res.headers.get("payment-required")).error).toBe("nonce_used");
    const files = (await (await fetch(`${base}/api/files`, { headers: bearer(token) })).json()).files;
    expect(files[0].expiresAt).toBe(expiresAt);
  });

  it("keeps the extension and records a pending payment when settlement has no clear answer", async () => {
    await start();
    facilitator.settle.mockRejectedValueOnce(new HttpError(502, "The payment service failed; try again shortly"));
    facilitator.settle.mockResolvedValueOnce({ success: true, transaction: "", network: X402.network });
    const { token } = await newToken();
    const a = await (await upload(token)).json();
    const b = await (await upload(token)).json();

    for (const { id } of [a, b]) {
      const res = await extend(token, id, 30 * DAY, { "payment-signature": signed(oneMonth()) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ paymentStatus: "pending", expiresAt: new Date(clock + 30 * DAY_MS).toISOString() });
    }
    const ledger = (await readFile(join(dir, "payments.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(ledger).toMatchObject([{ status: "pending", nonce: "0x1", payer: "0xpayer" }, { status: "pending" }]);
  });

  it("refuses to use one signed payment for two links at once", async () => {
    await start();
    let release!: () => void;
    facilitator.verify.mockImplementationOnce(() => new Promise((r) => { release = () => r({ isValid: true }); }));
    const { token } = await newToken();
    const a = await (await upload(token)).json();
    const b = await (await upload(token)).json();
    const first = extend(token, a.id, 30 * DAY, { "payment-signature": signed(oneMonth()) });
    await vi.waitFor(() => expect(facilitator.verify).toHaveBeenCalled());
    expect((await extend(token, b.id, 30 * DAY, { "payment-signature": signed(oneMonth()) })).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  it("quotes paid time to the hour, so a quote survives the round trip to the wallet", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    const quote = decode((await extend(token, id, 30 * DAY)).headers.get("payment-required")).accepts[0];
    clock += 10 * 60_000;
    const res = await extend(token, id, 30 * DAY - 600, { "payment-signature": signed(quote) });
    expect(res.status).toBe(200);
  });

  it("refuses a second extension of the same link while a payment is in flight", async () => {
    await start();
    let release!: () => void;
    facilitator.verify.mockImplementationOnce(() => new Promise((r) => { release = () => r({ isValid: true }); }));
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    const first = extend(token, id, 30 * DAY, { "payment-signature": signed(oneMonth()) });
    await vi.waitFor(() => expect(facilitator.verify).toHaveBeenCalled());
    expect((await extend(token, id, 6 * DAY)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  it("lets the admin give a token Pro, which raises its limits", async () => {
    await start();
    const { token, id } = await newToken();
    expect((await setPlan(token, id, "2026-11-09T12:00:00Z")).status).toBe(403);
    expect((await setPlan(ADMIN, "tok_missing", "2026-11-09T12:00:00Z")).status).toBe(404);
    expect((await setPlan(ADMIN, id, "soon")).status).toBe(400);

    const res = await setPlan(ADMIN, id, "2026-11-09T12:00:00Z");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, plan: "pro", planUntil: "2026-11-09T12:00:00.000Z" });

    const policy = await (await fetch(`${base}/api/config`, { headers: bearer(token) })).json();
    expect(policy).toMatchObject({ maxTtlSeconds: 90 * DAY, account: { id, plan: "pro", planUntil: "2026-11-09T12:00:00.000Z", quotaBytes: 500 } });

    const { id: fileId } = await (await upload(token, { "x-ttl-seconds": String(60 * DAY) })).json();
    expect((await extend(token, fileId, 89 * DAY)).status).toBe(200);

    expect(await (await setPlan(ADMIN, id, null)).json()).toEqual({ id, plan: "free" });
  });

  it("publishes the free plan and how to pay in the upload policy", async () => {
    await start();
    const { token, id } = await newToken();
    const policy = await (await fetch(`${base}/api/config`, { headers: bearer(token) })).json();
    expect(policy).toMatchObject({
      maxTtlSeconds: 7 * DAY,
      account: { id, plan: "free", quotaBytes: 100 },
      payments: { x402: { network: X402.network, asset: X402.asset, currency: "USDC", maxLifetimeSeconds: 365 * DAY } },
    });
  });
});
