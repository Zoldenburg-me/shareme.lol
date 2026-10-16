import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accept, FakeFiatToken, type AcceptOptions } from "@zold/accept";
import { openSqlite, SqliteRateLimiter, SqliteSellerLedger, SqliteSingleUseStore } from "@zold/accept/sqlite";
import { evmX402Signer } from "agentpay-hub";
import { encodePaymentSignature } from "agentpay-hub/protocol";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/app.js";
import type { HostConfig } from "../src/config.js";
import { createReconciler, fileRef, paymentHolds } from "../src/extend.js";
import { SignupLimiter } from "../src/signupLimiter.js";
import { FileStore } from "../src/store.js";
import { TokenStore } from "../src/tokens.js";
import { acceptOptions } from "../src/x402.js";
import type { X402Config } from "../src/x402Config.js";

const ADMIN = "a".repeat(40);
const DAY = 86_400;
const DAY_MS = DAY * 1000;
const PAY_TO = "0x" + "ab".repeat(20);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const X402: X402Config = {
  payTo: PAY_TO,
  network: "eip155:84532",
  chainId: 84532,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  assetDecimals: 6,
  assetSymbol: "USDC",
  rpcUrl: "https://rpc.invalid/",
  gasPrivateKey: `0x${"11".repeat(32)}`,
  maxGas: 150_000n,
  maxFeePerGas: 10_000_000_000n,
  pricePerFileMonth: 10_000,
  pricePerGbMonth: 20_000,
  maxLifetimeSeconds: 365 * DAY,
  maxTimeoutSeconds: 120,
};

const decode = (header: string | null) => JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8"));

describe("extending links and paying with x402", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let clock: number;
  let tokens: TokenStore;
  let chain: FakeFiatToken;
  let ledger: SqliteSellerLedger;
  let onError: ReturnType<typeof vi.fn>;
  let store: FileStore;
  let payments: Parameters<typeof createReconciler>[1];
  const buyer = evmX402Signer(generatePrivateKey(), () => clock);

  const start = async (overrides: Partial<HostConfig> = {}, acceptOverrides: Partial<AcceptOptions> = {}) => {
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
    const db = openSqlite(":memory:");
    ledger = new SqliteSellerLedger(db);
    store = await FileStore.open(dir);
    payments = {
      ledger,
      paying: new Set(),
      acceptor: accept({ ...acceptOptions(X402, "https://shareme.lol"), ...acceptOverrides }, {
        ledger, claims: new SqliteSingleUseStore(db), rateLimiter: new SqliteRateLimiter(db), chain, submitter: chain, onError,
        // Each poll lets time pass, so a settlement that never confirms runs into its timeout.
        now: () => clock, sleep: async (ms: number) => { clock += ms; },
      }),
    };
    server = createServer(config, store, () => clock, undefined, { tokens, limiter: new SignupLimiter(100, 1000) }, payments);
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
  /** A fake USDC with the buyer funded; without autoMine nothing is mined until `mine()`. */
  const newChain = (autoMine: boolean) => {
    const fake = new FakeFiatToken({
      chainId: X402.chainId, asset: X402.asset, nowSec: () => Math.floor(clock / 1000), autoMine,
      domain: { name: "USDC", version: "2", chainId: X402.chainId, verifyingContract: X402.asset as `0x${string}` },
    });
    fake.mint(buyer.address, 1_000_000n);
    return fake;
  };
  const balance = (owner: string) => chain.balanceOfSync(owner);
  /** What the agent's wallet sends back for the quote in a 402: a signed EIP-3009 authorization. */
  const pay = async (quote: Response, tamper: Record<string, string> = {}) => {
    const accepted = { ...decode(quote.headers.get("payment-required")).accepts[0], ...tamper };
    return encodePaymentSignature({ x402Version: 2, accepted, payload: (await buyer.signX402(accepted)).payload });
  };
  const expiryOf = async (token: string, id: string) =>
    ((await (await fetch(`${base}/api/files`, { headers: bearer(token) })).json()).files as { id: string; expiresAt: string }[]).find((f) => f.id === id)?.expiresAt;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-extend-"));
    clock = Date.parse("2026-10-09T12:00:00Z");
    chain = newChain(true);
    onError = vi.fn();
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
    expect(chain.submissions).toHaveLength(0);
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
    expect(required).toMatchObject({
      x402Version: 2,
      resource: { url: "https://shareme.lol/api/files/extend" },
      // What the host charges for extending a 5-byte file by up to 30 days past the free limit.
      accepts: [{ scheme: "exact", network: "eip155:84532", amount: "10001", asset: X402.asset, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } }],
    });
    expect(JSON.stringify(required)).not.toContain(id);
    expect(await res.json()).toMatchObject({ code: "PAYMENT_REQUIRED", price: "0.010001", currency: "USDC", paymentRequired: required });
    expect(res.headers.get("cache-control")).toBe("no-store");
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

  it("settles the payment on chain, then extends the link, and keeps the link id out of the ledger", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();

    const res = await extend(token, id, 30 * DAY, { "payment-signature": await pay(await extend(token, id, 30 * DAY)) });
    expect(res.status).toBe(200);
    expect((await res.json()).expiresAt).toBe(new Date(clock + 30 * DAY_MS).toISOString());
    expect(chain.submissions).toHaveLength(1);
    expect(decode(res.headers.get("payment-response"))).toMatchObject({ success: true, transaction: chain.submissions[0], network: "eip155:84532" });
    expect(balance(PAY_TO)).toBe(10_001n);
    expect(balance(buyer.address)).toBe(1_000_000n - 10_001n);

    const rows = await ledger.list();
    expect(rows).toMatchObject([{ status: "settled", delivered: true, amount: "10001", path: "/api/files/extend", meta: { fileRef: fileRef(id) } }]);
    expect(JSON.stringify(rows)).not.toContain(id);
  });

  it("applies a payment once: a replay changes nothing, and can't buy time for another link", async () => {
    await start();
    const { token } = await newToken();
    const a = await (await upload(token)).json();
    const b = await (await upload(token)).json();
    const payment = await pay(await extend(token, a.id, 30 * DAY));
    expect((await extend(token, a.id, 30 * DAY, { "payment-signature": payment })).status).toBe(200);
    const paidUntil = await expiryOf(token, a.id);

    // The same request again: already extended, so nothing is charged or changed.
    const again = await extend(token, a.id, 30 * DAY, { "payment-signature": payment });
    expect(again.status).toBe(200);
    expect(again.headers.get("payment-response")).toBeNull();
    // The same payment asking for more days still only buys what it was priced for.
    const longer = await extend(token, a.id, 40 * DAY, { "payment-signature": payment });
    expect(longer.status).toBe(200);
    expect((await longer.json()).expiresAt).toBe(paidUntil);
    // For another link it is a replay.
    const other = await extend(token, b.id, 30 * DAY, { "payment-signature": payment });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: "NONCE_REPLAY" });

    expect(chain.submissions).toHaveLength(1);
    expect(balance(PAY_TO)).toBe(10_001n);
    expect(await expiryOf(token, a.id)).toBe(paidUntil);
    expect(await expiryOf(token, b.id)).toBe(b.expiresAt);
  });

  it("only charges for time past what the link already has", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    await extend(token, id, 30 * DAY, { "payment-signature": await pay(await extend(token, id, 30 * DAY)) });

    // Already paid through day 30; 40 days out needs one more started month.
    const res = await extend(token, id, 40 * DAY);
    expect(decode(res.headers.get("payment-required")).accepts[0].amount).toBe("10001");
  });

  it("refuses a payment for the wrong amount or with a bad signature, leaving the link alone", async () => {
    await start();
    const { token } = await newToken();
    const { id, expiresAt } = await (await upload(token)).json();
    const quote = await extend(token, id, 30 * DAY);

    const under = await extend(token, id, 30 * DAY, { "payment-signature": await pay(quote.clone(), { amount: "1" }) });
    expect(under.status).toBe(402);
    expect((await under.json()).code).toMatch(/UNDERPAID|AMOUNT_MISMATCH/);
    expect(decode(under.headers.get("payment-required")).accepts[0].amount).toBe("10001");

    // Signed by another key, but claiming to come from the funded buyer.
    const accepted = decode(quote.headers.get("payment-required")).accepts[0];
    const { payload } = await evmX402Signer(`0x${"22".repeat(32)}`, () => clock).signX402(accepted);
    const authorization = { ...(payload.authorization as Record<string, string>), from: buyer.address };
    const forged = encodePaymentSignature({ x402Version: 2, accepted, payload: { ...payload, authorization } });
    expect((await extend(token, id, 30 * DAY, { "payment-signature": forged })).status).toBe(402);
    expect((await extend(token, id, 30 * DAY, { "payment-signature": "%%%" })).status).toBe(400);

    expect(chain.submissions).toHaveLength(0);
    expect(await expiryOf(token, id)).toBe(expiresAt);
  });

  it("refuses a payer who can't cover the price, leaving the link alone", async () => {
    await start();
    chain.burn(buyer.address);
    const { token } = await newToken();
    const { id, expiresAt } = await (await upload(token)).json();
    const res = await extend(token, id, 30 * DAY, { "payment-signature": await pay(await extend(token, id, 30 * DAY)) });
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("INSUFFICIENT_FUNDS");
    expect(chain.submissions).toHaveLength(0);
    expect(await expiryOf(token, id)).toBe(expiresAt);
  });

  it("reports a settlement that outlasts the request as pending, then extends the link once when it settles", async () => {
    chain = newChain(false);
    clock += 60_000; // off the hour, so the retry below falls in the same paid hour
    await start({}, { settlementTimeoutMs: 3_000, pollIntervalMs: 1_000 });
    const { token } = await newToken();
    const { id, expiresAt } = await (await upload(token)).json();
    const quote = await extend(token, id, 30 * DAY);
    const paidUntil = new Date(Math.ceil((clock + 30 * DAY_MS) / 3_600_000) * 3_600_000).toISOString();
    const payment = await pay(quote);

    // The transfer is broadcast but never mined while the request waits.
    const slow = await extend(token, id, 30 * DAY, { "payment-signature": payment });
    expect(slow.status).toBe(503);
    expect(slow.headers.get("retry-after")).toBe("5");
    const body = await slow.json();
    expect(body).toMatchObject({ code: "SETTLEMENT_TIMEOUT", paymentStatus: "pending" });
    expect(body.error).toMatch(/same payment; don't sign a new one/);
    expect(chain.submissions).toHaveLength(1);
    expect(await expiryOf(token, id)).toBe(expiresAt);

    // Mined later; the timer settles the payment and delivers the extension without the payer coming back.
    chain.mine(3);
    const reconcile = createReconciler(store, payments);
    expect(await reconcile(clock)).toMatchObject({ settled: 1, delivered: 1 });
    expect(await expiryOf(token, id)).toBe(paidUntil);
    expect(await ledger.list()).toMatchObject([{ status: "settled", delivered: true }]);
    expect(await reconcile(clock)).toMatchObject({ settled: 0, delivered: 0 });

    // The payer's retry with the same payment gets the receipt and changes nothing.
    const retry = await extend(token, id, 30 * DAY, { "payment-signature": payment });
    expect(retry.status).toBe(200);
    expect(await expiryOf(token, id)).toBe(paidUntil);
    expect(chain.submissions).toHaveLength(1);
    expect(balance(PAY_TO)).toBe(10_001n);
  });

  it("reports a settled payment whose link is gone once, and keeps it undelivered", async () => {
    chain = newChain(false);
    await start({}, { settlementTimeoutMs: 3_000, pollIntervalMs: 1_000 });
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    const payment = await pay(await extend(token, id, 30 * DAY));
    expect((await extend(token, id, 30 * DAY, { "payment-signature": payment })).status).toBe(503);
    expect((await fetch(`${base}/api/files/${id}`, { method: "DELETE", headers: bearer(token) })).status).toBe(204);

    chain.mine(3);
    const reconcile = createReconciler(store, payments);
    expect(await reconcile(clock)).toMatchObject({ settled: 1, delivered: 0 });
    await reconcile(clock);
    expect(onError.mock.calls.filter(([e]) => /link is gone/.test(String((e as Error).message)))).toHaveLength(1);
    expect(await ledger.list()).toMatchObject([{ status: "settled", delivered: false }]);
  });

  it("extends the link from the reconciler when the extension failed after settlement", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    const payment = await pay(await extend(token, id, 30 * DAY));
    // The payment settles, then writing the new expiry fails: the payment stays undelivered.
    vi.spyOn(store, "setExpiry").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await extend(token, id, 30 * DAY, { "payment-signature": payment })).status).toBe(500);
    expect(await ledger.list()).toMatchObject([{ status: "settled", delivered: false }]);

    expect(await createReconciler(store, payments)(clock)).toMatchObject({ delivered: 1 });
    expect(await expiryOf(token, id)).toBe(new Date(clock + 30 * DAY_MS).toISOString());
    expect(await ledger.list()).toMatchObject([{ status: "settled", delivered: true }]);
    expect(await createReconciler(store, payments)(clock)).toMatchObject({ delivered: 0 });
    expect(chain.submissions).toHaveLength(1);
  });

  it("keeps a link that expires while its payment settles, and revives it when the payer checks back", async () => {
    chain = newChain(false);
    clock += 60_000;
    await start({}, { settlementTimeoutMs: 3_000, pollIntervalMs: 1_000 });
    const { token } = await newToken();
    const { id } = await (await upload(token, { "x-ttl-seconds": "60" })).json();
    const payment = await pay(await extend(token, id, 30 * DAY));
    const quotedUntil = Math.ceil((clock + 30 * DAY_MS) / 3_600_000) * 3_600_000;
    expect((await extend(token, id, 30 * DAY, { "payment-signature": payment })).status).toBe(503);

    // Mined soon after, but nobody has delivered it yet. The old expiry passes and the hour rolls over;
    // the sweep keeps the link for the settled, not yet extended payment.
    chain.mine(3);
    clock += 2 * 3_600_000;
    expect(await store.sweep(clock, await paymentHolds(payments))).toEqual([]);
    expect((await fetch(`${base}/f/${id}/a.md`)).status).toBe(404);

    // The payer's retry, same arguments in a later hour, resolves the payment as it was priced.
    const retry = await extend(token, id, 30 * DAY, { "payment-signature": payment });
    expect(retry.status).toBe(200);
    expect((await retry.json()).expiresAt).toBe(new Date(quotedUntil).toISOString());
    expect(decode(retry.headers.get("payment-response"))).toMatchObject({ success: true });
    expect(chain.submissions).toHaveLength(1);
    expect(await store.sweep(clock, await paymentHolds(payments))).toEqual([]);
  });

  it("lets the sweep delete a held link once its payment is conclusively refused", async () => {
    chain = newChain(false);
    await start({}, { settlementTimeoutMs: 3_000, pollIntervalMs: 1_000 });
    const { token } = await newToken();
    const { id } = await (await upload(token, { "x-ttl-seconds": "60" })).json();
    const payment = await pay(await extend(token, id, 30 * DAY));
    expect((await extend(token, id, 30 * DAY, { "payment-signature": payment })).status).toBe(503);
    chain.dropPending(); // never mined, and now never will be

    clock += 10 * 60_000; // past the authorization's validBefore and the grace period
    expect(await store.sweep(clock, await paymentHolds(payments))).toEqual([]);
    expect(await createReconciler(store, payments)(clock)).toMatchObject({ refused: 1, delivered: 0 });
    expect(await store.sweep(clock, await paymentHolds(payments))).toEqual([id]);
    expect(balance(PAY_TO)).toBe(0n);
  });

  it("quotes paid time to the hour, so a quote survives the round trip to the wallet", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    const quote = await extend(token, id, 30 * DAY);
    clock += 10 * 60_000;
    const res = await extend(token, id, 30 * DAY - 600, { "payment-signature": await pay(quote) });
    expect(res.status).toBe(200);
  });

  it("refuses a second extension of the same link while a payment settles", async () => {
    await start();
    const { token } = await newToken();
    const { id } = await (await upload(token)).json();
    const payment = await pay(await extend(token, id, 30 * DAY));
    const held = chain.pauseNextSimulation();
    const first = extend(token, id, 30 * DAY, { "payment-signature": payment });
    await held.reached;
    expect((await extend(token, id, 6 * DAY)).status).toBe(409);
    held.release();
    expect((await first).status).toBe(200);
    expect(onError).not.toHaveBeenCalled();
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
