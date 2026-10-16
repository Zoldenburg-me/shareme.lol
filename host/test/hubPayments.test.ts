import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accept, FakeFiatToken, hostedSettle, parseAcceptOptions } from "@zold/accept";
import { openSqlite, SqliteRateLimiter, SqliteSellerLedger, SqliteSingleUseStore } from "@zold/accept/sqlite";
import type { DatabaseSync } from "node:sqlite";
import { evmX402Signer } from "agentpay-hub";
import { encodePaymentSignature } from "agentpay-hub/protocol";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/app.js";
import type { HostConfig } from "../src/config.js";
import { createLegacyDelivery, fileRef, paymentHolds } from "../src/extend.js";
import { SignupLimiter } from "../src/signupLimiter.js";
import { FileStore } from "../src/store.js";
import { TokenStore } from "../src/tokens.js";
import { HubPaymentRecords } from "../src/hubRecords.js";
import { acceptOptions, assertNoOpenLegacy, HUB_TIMEOUT_MS, openHubPayments, type HubPayments } from "../src/x402.js";
import type { HubSettlement, X402Config } from "../src/x402Config.js";

const ADMIN = "a".repeat(40);
const DAY = 86_400;
const DAY_MS = DAY * 1000;
const PAY_TO = "0x" + "ab".repeat(20);
const HUB: HubSettlement = { kind: "hub", url: "https://hub.example", key: `zsk_${"k".repeat(32)}` };
const X402: X402Config = {
  payTo: PAY_TO,
  network: "eip155:84532",
  chainId: 84532,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  assetDecimals: 6,
  assetSymbol: "USDC",
  settlement: HUB,
  pricePerFileMonth: 10_000,
  pricePerGbMonth: 20_000,
  maxLifetimeSeconds: 365 * DAY,
  maxTimeoutSeconds: 120,
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const decode = (header: string | null) => JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8"));

type HubCall = { url: string; authorization: string; body: { request: { path: string; headers: Record<string, string> }; price: { amount: string; meta: Record<string, string> } } };

describe("paying for extensions through a Zold hub (zoldSeller)", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let clock: number;
  let chain: FakeFiatToken;
  let hubLedger: SqliteSellerLedger;
  let payments: HubPayments;
  let store: FileStore;
  let calls: HubCall[];
  /** What the hub's network does with the next call: answer it, lose the answer after settling, or be down. */
  let network: "up" | "lose-answer" | "down" | "rate-limited";
  const buyer = evmX402Signer(generatePrivateKey(), () => clock);

  /** The hub: @zold/accept's real hostedSettle route over its own acceptor, ledger and (fake) chain. */
  const newHub = () => {
    const db = openSqlite(":memory:");
    hubLedger = new SqliteSellerLedger(db);
    const acceptor = accept({ ...acceptOptions(X402, "https://shareme.lol"), sellerAccountId: "hub:shareme", settlementTimeoutMs: 3_000, pollIntervalMs: 1_000 }, {
      ledger: hubLedger, claims: new SqliteSingleUseStore(db), rateLimiter: new SqliteRateLimiter(db), chain, submitter: chain,
      onError: () => undefined, now: () => clock, sleep: async (ms: number) => { clock += ms; },
    });
    const settle = hostedSettle({ acceptorFor: (key) => (key === HUB.key ? acceptor : undefined), onError: () => undefined });
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (network === "down") throw new TypeError("fetch failed");
      if (network === "rate-limited") {
        const limited = { kind: "respond", status: 429, headers: { "retry-after": "60" }, body: JSON.stringify({ error: "RATE_LIMITED" }) };
        return new Response(JSON.stringify(limited), { status: 200 });
      }
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), authorization: headers.authorization, body });
      const answer = await settle({ authorization: headers.authorization, body });
      if (network === "lose-answer") throw new TypeError("socket hang up");
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    });
  };

  const start = async (fetchImpl: typeof fetch) => {
    const config: HostConfig = {
      apiToken: ADMIN, publicBaseUrl: "https://shareme.lol", dataDir: dir, port: 0, defaultTtlSeconds: DAY, maxTtlSeconds: 7 * DAY,
      maxFileBytes: 1000, landingPage: "site/index.html", maxTotalBytes: 100_000, sweepIntervalMs: 60_000, allowedExtensions: ["md"],
      openSignup: true, tokenQuotaBytes: 100, signupsPerIpPerHour: 100, signupsPerDay: 1000, trustCfConnectingIp: true,
      apiRequestsPerIpPerMinute: 1000, authFailuresPerIpPerHour: 30, uploadsPerTokenPerHour: 60, downloadsPerIpPerMinute: 300,
      shortLinkMissesPerIpPerHour: 60, maxFilesPerToken: 2, concurrentUploadsPerToken: 2, minUploadBytesPerSecond: 1,
      uploadPaceWindowMs: 10_000, pro: { maxTtlSeconds: 90 * DAY, quotaBytes: 500, maxFiles: 5 }, x402: X402,
    };
    const tokens = await TokenStore.open(dir);
    store = await FileStore.open(dir);
    payments = openHubPayments(X402, HUB, dir, fetchImpl);
    server = createServer(config, store, () => clock, undefined, { tokens, limiter: new SignupLimiter(100, 1000) }, payments);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { token } = (await (await fetch(`${base}/api/tokens`, { method: "POST" })).json()) as { token: string };
    return { token, id: await upload(token) };
  };
  const upload = async (token: string): Promise<string> =>
    (await (await fetch(`${base}/api/files`, { method: "POST", headers: { ...bearer(token), "x-filename": "a.md" }, body: "hello" })).json()).id;
  const expiryOf = async (token: string, id: string) =>
    ((await (await fetch(`${base}/api/files`, { headers: bearer(token) })).json()).files as { id: string; expiresAt: string }[]).find((f) => f.id === id)?.expiresAt;

  const extend = (token: string, id: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/files/${id}/extend`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json", ...headers }, body: JSON.stringify({ ttlSeconds: 30 * DAY }) });
  const pay = async (quote: Response) => {
    const accepted = decode(quote.headers.get("payment-required")).accepts[0];
    return encodePaymentSignature({ x402Version: 2, accepted, payload: (await buyer.signX402(accepted)).payload });
  };

  /** A fake USDC with the buyer funded; without autoMine nothing is mined until `mine()`. */
  const newChain = (autoMine: boolean) => {
    const fake = new FakeFiatToken({
      chainId: X402.chainId, asset: X402.asset, nowSec: () => Math.floor(clock / 1000), autoMine,
      domain: { name: "USDC", version: "2", chainId: X402.chainId, verifyingContract: X402.asset as `0x${string}` },
    });
    fake.mint(buyer.address, 1_000_000n);
    return fake;
  };
  const isHeld = async (id: string) => (await paymentHolds(payments))({ id } as Parameters<Awaited<ReturnType<typeof paymentHolds>>>[0]);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-hub-"));
    clock = Date.parse("2026-10-09T12:00:00Z");
    chain = newChain(true);
    calls = [];
    network = "up";
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("passes on the hub's offer, sending it only the price, the link's ref and the seller key", async () => {
    const { token, id } = await start(newHub());
    const res = await extend(token, id);
    expect(res.status).toBe(402);
    expect(decode(res.headers.get("payment-required")).accepts[0]).toMatchObject({ amount: "10001", asset: X402.asset, payTo: PAY_TO, network: "eip155:84532" });
    expect(await res.json()).toMatchObject({ code: "PAYMENT_REQUIRED", price: "0.010001", currency: "USDC" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hub.example/api/agent-payments/settle");
    expect(calls[0].authorization).toBe(`Bearer ${HUB.key}`);
    expect(calls[0].body.request.path).toBe("/api/files/extend");
    expect(calls[0].body.price).toEqual({ amount: "10001", meta: { fileRef: fileRef(id), until: String(clock + 30 * DAY_MS) } });
    // The bearer token for share me stays here: the hub only gets payment headers.
    expect(JSON.stringify(calls[0].body)).not.toContain(id);
    expect(JSON.stringify(calls[0].body)).not.toContain(token);
  });

  it("extends the link once the hub has settled, and a replay charges nothing", async () => {
    const { token, id } = await start(newHub());
    const payment = await pay(await extend(token, id));
    const res = await extend(token, id, { "payment-signature": payment });
    expect(res.status).toBe(200);
    expect((await res.json()).expiresAt).toBe(new Date(clock + 30 * DAY_MS).toISOString());
    expect(chain.submissions).toHaveLength(1);
    expect(chain.balanceOfSync(PAY_TO)).toBe(10_001n);

    const again = await extend(token, id, { "payment-signature": payment });
    expect(again.status).toBe(200);
    expect(chain.submissions).toHaveLength(1);
    expect(await hubLedger.list()).toMatchObject([{ status: "settled", amount: "10001" }]);
  });

  it("answers pending when the hub's answer is lost, and extends on the payer's retry without a second charge", async () => {
    const { token, id } = await start(newHub());
    const payment = await pay(await extend(token, id));
    network = "lose-answer";
    const lost = await extend(token, id, { "payment-signature": payment });
    expect(lost.status).toBe(503);
    expect(await lost.json()).toMatchObject({ paymentStatus: "pending" });
    expect(chain.submissions).toHaveLength(1); // the hub settled; this host just never heard

    network = "up";
    const retry = await extend(token, id, { "payment-signature": payment });
    expect(retry.status).toBe(200);
    expect((await retry.json()).expiresAt).toBe(new Date(clock + 30 * DAY_MS).toISOString());
    expect(chain.submissions).toHaveLength(1);
  });

  it("fails closed when the hub is down, leaving the link alone", async () => {
    const { token, id } = await start(newHub());
    const payment = await pay(await extend(token, id));
    network = "down";
    const res = await extend(token, id, { "payment-signature": payment });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ paymentStatus: "pending" });
    expect(chain.submissions).toHaveLength(0);
    expect(new Date((await (await fetch(`${base}/api/files`, { headers: bearer(token) })).json()).files[0].expiresAt).getTime()).toBe(clock + DAY_MS);
  });

  it("never takes a paid answer for another price as payment", async () => {
    const lying = vi.fn(async () => new Response(JSON.stringify({
      kind: "paid", headers: {},
      paid: { claimKey: "c", protocol: "x402", payer: PAY_TO, amount: "1", chainId: 84532, asset: X402.asset, nonce: "n", method: "POST", path: "/api/files/extend", meta: {}, settled: true, replayed: false },
    }), { status: 200 }));
    const { token, id } = await start(lying);
    const res = await extend(token, id, { "payment-signature": "e30=" });
    expect(res.status).toBe(503);
    expect(new Date((await (await fetch(`${base}/api/files`, { headers: bearer(token) })).json()).files[0].expiresAt).getTime()).toBe(clock + DAY_MS);
  });

  it("retries a payment at its first price across an hour boundary, extending once", async () => {
    const { token, id } = await start(newHub());
    const payment = await pay(await extend(token, id));
    const until = new Date(clock + 30 * DAY_MS).toISOString();
    network = "lose-answer";
    expect((await extend(token, id, { "payment-signature": payment })).status).toBe(503);
    clock += 2 * 3_600_000; // re-priced now, the link would end two hours later and the hub would refuse it
    network = "up";
    const retry = await extend(token, id, { "payment-signature": payment });
    expect(retry.status).toBe(200);
    expect((await retry.json()).expiresAt).toBe(until);
    expect(chain.submissions).toHaveLength(1);
    expect(calls.at(-1)?.body.price.meta.until).toBe(String(Date.parse(until)));
  });

  it("refuses the same payment for a different link", async () => {
    const { token, id } = await start(newHub());
    const other = await upload(token);
    const payment = await pay(await extend(token, id));
    expect((await extend(token, id, { "payment-signature": payment })).status).toBe(200);
    const reused = await extend(token, other, { "payment-signature": payment });
    expect(reused.status).toBe(409);
    expect((await reused.json()).error).toMatch(/another link/);
    expect(await expiryOf(token, other)).toBe(new Date(clock + DAY_MS).toISOString());
    expect(chain.submissions).toHaveLength(1);
  });

  it("keeps a link the hub is still settling a payment for past its expiry, and revives it on the retry", async () => {
    chain = newChain(false);
    clock += 60_000; // off the hour, as a real request would be
    const { token, id } = await start(newHub());
    const payment = await pay(await extend(token, id));
    const until = new Date(Math.ceil((clock + 30 * DAY_MS) / 3_600_000) * 3_600_000).toISOString();
    const slow = await extend(token, id, { "payment-signature": payment });
    expect(slow.status).toBe(503);
    expect(await slow.json()).toMatchObject({ code: "SETTLEMENT_TIMEOUT", paymentStatus: "pending" });
    // Mined soon after; the payer only comes back after the free day has passed.
    chain.mine(3);
    clock += 2 * DAY_MS;
    expect(await store.sweep(clock, await paymentHolds(payments))).toEqual([]);
    const retry = await extend(token, id, { "payment-signature": payment });
    expect(retry.status).toBe(200);
    expect((await retry.json()).expiresAt).toBe(until);
    expect(await isHeld(id)).toBe(false); // delivered: the record holds nothing now
  });

  it("lets a refused payment hold nothing, so its link expires on time", async () => {
    const { token, id } = await start(newHub());
    const broke = evmX402Signer(generatePrivateKey(), () => clock); // no USDC
    const accepted = decode((await extend(token, id)).headers.get("payment-required")).accepts[0];
    const unfunded = encodePaymentSignature({ x402Version: 2, accepted, payload: (await broke.signX402(accepted)).payload });
    const res = await extend(token, id, { "payment-signature": unfunded });
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("INSUFFICIENT_FUNDS");
    expect(await isHeld(id)).toBe(false);
    clock += 2 * DAY_MS;
    expect(await store.sweep(clock, await paymentHolds(payments))).toEqual([id]);
  });

  it("holds the link of a payment whose answer was lost, and extends it when the payer retries after expiry", async () => {
    const { token, id } = await start(newHub());
    const payment = await pay(await extend(token, id));
    const until = new Date(clock + 30 * DAY_MS).toISOString();
    network = "lose-answer"; // the hub settles, but its answer never arrives (like a host timeout)
    expect((await extend(token, id, { "payment-signature": payment })).status).toBe(503);
    expect(await isHeld(id)).toBe(true);
    clock += 2 * DAY_MS;
    expect(await store.sweep(clock, await paymentHolds(payments))).toEqual([]);
    network = "up";
    const retry = await extend(token, id, { "payment-signature": payment });
    expect(retry.status).toBe(200);
    expect((await retry.json()).expiresAt).toBe(until);
    expect(chain.submissions).toHaveLength(1);
  });

  it("keeps a held payment and its first price through a rate-limited retry", async () => {
    chain = newChain(false);
    clock += 60_000;
    const { token, id } = await start(newHub());
    const payment = await pay(await extend(token, id));
    const until = new Date(Math.ceil((clock + 30 * DAY_MS) / 3_600_000) * 3_600_000).toISOString();
    expect((await extend(token, id, { "payment-signature": payment })).status).toBe(503); // still settling
    network = "rate-limited";
    const limited = await extend(token, id, { "payment-signature": payment });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED", paymentStatus: "pending" });
    expect(await isHeld(id)).toBe(true);
    chain.mine(3);
    clock += 2 * 3_600_000; // a fresh price would end two hours later
    network = "up";
    const retry = await extend(token, id, { "payment-signature": payment });
    expect(retry.status).toBe(200);
    expect((await retry.json()).expiresAt).toBe(until);
  });

  it("holds a link the hub was paid for until it is extended, so a failure in between is retried", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { token, id } = await start(newHub());
    const payment = await pay(await extend(token, id));
    const until = new Date(clock + 30 * DAY_MS).toISOString();
    vi.spyOn(store, "setExpiry").mockRejectedValueOnce(new Error("disk full"));
    expect((await extend(token, id, { "payment-signature": payment })).status).toBe(500);
    expect(await isHeld(id)).toBe(true);
    clock += 2 * DAY_MS;
    expect(await store.sweep(clock, await paymentHolds(payments))).toEqual([]);
    const retry = await extend(token, id, { "payment-signature": payment });
    expect(retry.status).toBe(200);
    expect((await retry.json()).expiresAt).toBe(until);
    expect(chain.submissions).toHaveLength(1);
    log.mockRestore();
  });

  it("waits for the hub longer than the hub waits for confirmations, and less than the MCP client waits", () => {
    const { settlementTimeoutMs: _ours, ...hubDefaults } = acceptOptions(X402, "https://shareme.lol");
    expect(HUB_TIMEOUT_MS).toBeGreaterThan(parseAcceptOptions(hubDefaults).settlementTimeoutMs);
    expect(HUB_TIMEOUT_MS).toBeLessThan(90_000); // mcp/src/client.ts EXTEND_TIMEOUT_MS
  });

  it("lets a first rate-limited payment hold nothing, so a junk one can't keep a file", async () => {
    const { token, id } = await start(newHub());
    const payment = await pay(await extend(token, id));
    network = "rate-limited";
    const res = await extend(token, id, { "payment-signature": payment });
    expect(res.status).toBe(429);
    expect(await isHeld(id)).toBe(false);
    clock += 2 * DAY_MS;
    expect(await store.sweep(clock, await paymentHolds(payments))).toEqual([id]);
  });

  it("adds the held column to a table from before it, keeping undelivered rows' links held", () => {
    const db = openSqlite(":memory:");
    db.exec(`CREATE TABLE hub_payments (key TEXT PRIMARY KEY, file_ref TEXT NOT NULL, until INTEGER NOT NULL, amount TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    db.exec("INSERT INTO hub_payments VALUES ('open', 'linkA', 1, '1', 0, 0), ('done', 'linkB', 1, '1', 1, 0)");
    const records = new HubPaymentRecords(db);
    expect(records.undeliveredRefs()).toEqual(new Set(["linkA"]));
    records.remember("new", "linkC", 1, 1n, 0);
    expect(records.undeliveredRefs()).toEqual(new Set(["linkA"]));
    new HubPaymentRecords(db); // reopening changes nothing
    expect(records.undeliveredRefs()).toEqual(new Set(["linkA"]));
  });

  it("holds only the link a payment was recorded for", () => {
    const records = new HubPaymentRecords(openSqlite(":memory:"));
    records.remember("k", "linkA", 1, 1n, 0);
    records.markHeld("k", "linkB");
    expect(records.undeliveredRefs()).toEqual(new Set());
    records.markHeld("k", "linkA");
    expect(records.undeliveredRefs()).toEqual(new Set(["linkA"]));
  });

  describe("after a switch from settling here", () => {
    /** A row the host's own ledger recorded while it settled payments itself, in the same payments.db. */
    const legacyRow = async (db: DatabaseSync, id: string, status: "settled" | "submitted") => {
      const ledger = new SqliteSellerLedger(db);
      const claimKey = `legacy-${status}`;
      await ledger.recordVerified({
        claimKey, sellerAccountId: "share-me", protocol: "x402", chainId: 84532, asset: X402.asset, payer: buyer.address, nonce: `0x${"01".repeat(32)}`,
        amount: "10001", payTo: PAY_TO, validBefore: String(Math.floor(clock / 1000) + 120), method: "POST", path: "/api/files/extend",
        queryDigest: "q", headerDigest: "h", meta: { fileRef: fileRef(id), until: String(clock + 30 * DAY_MS) },
      });
      await ledger.recordSubmitted(claimKey, `0x${"aa".repeat(32)}`);
      if (status === "settled") await ledger.recordSettled(claimKey, `0x${"aa".repeat(32)}`);
    };

    it("delivers payments it settled itself but never extended, holding the link until then", async () => {
      await start(newHub());
      const { token } = (await (await fetch(`${base}/api/tokens`, { method: "POST" })).json()) as { token: string };
      const id = await upload(token);
      await legacyRow(openSqlite(join(dir, "payments.db")), id, "settled");
      const hub = openHubPayments(X402, HUB, dir, newHub()); // reopened, as at the next start
      await assertNoOpenLegacy(hub);
      payments = hub;
      expect(await isHeld(id)).toBe(true);
      expect(await createLegacyDelivery(store, hub.legacy as NonNullable<HubPayments["legacy"]>, () => undefined)(clock)).toMatchObject({ delivered: 1 });
      expect(await expiryOf(token, id)).toBe(new Date(clock + 30 * DAY_MS).toISOString());
      expect(await isHeld(id)).toBe(false);
    });

    it("refuses to start while a payment it started settling itself is unresolved", async () => {
      const { id } = await start(newHub());
      await legacyRow(openSqlite(join(dir, "payments.db")), id, "submitted");
      await expect(assertNoOpenLegacy(openHubPayments(X402, HUB, dir, newHub()))).rejects.toThrow(/1 payment\(s\) this host is still settling itself/);
    });

    it("starts a hub on a fresh data dir with no ledger to drain", async () => {
      await start(newHub());
      expect(payments.legacy).toBeUndefined();
    });
  });

  it("reports a payment the hub settled for a link that was revoked meanwhile", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hub = newHub();
    const { token, id } = await start(vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.body && JSON.parse(String(init.body)).request.headers["payment-signature"]) {
        await fetch(`${base}/api/files/${id}`, { method: "DELETE", headers: bearer(token) });
      }
      return hub(url, init);
    }));
    const res = await extend(token, id, { "payment-signature": await pay(await extend(token, id)) });
    expect(res.status).toBe(404);
    expect(chain.submissions).toHaveLength(1);
    expect(log.mock.calls.join(" ")).toContain(`payment for link ${fileRef(id)} settled at the hub, but extending the link failed`);
    log.mockRestore();
  });

  it("refuses a paid answer on another chain or token", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const otherChain = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { price } = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        kind: "paid", headers: {},
        paid: { claimKey: "c", protocol: "x402", payer: PAY_TO, amount: price.amount, chainId: 8453, asset: X402.asset, nonce: "n", method: "POST", path: "/api/files/extend", meta: price.meta, settled: true, replayed: false },
      }), { status: 200 });
    });
    const { token, id } = await start(otherChain);
    const res = await extend(token, id, { "payment-signature": "e30=" });
    expect(res.status).toBe(502);
    expect(await expiryOf(token, id)).toBe(new Date(clock + DAY_MS).toISOString());
    log.mockRestore();
  });

  it("says the payment service is unavailable when a quote can't be had", async () => {
    const { token, id } = await start(newHub());
    network = "down";
    const res = await extend(token, id);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/payment service is unavailable/);
    expect(body).not.toHaveProperty("paymentStatus");
  });

  it("holds a link from the sweep while its payment request is in flight here", async () => {
    await start(newHub());
    const holds = await paymentHolds(payments);
    const meta = { id: "x" } as Parameters<typeof holds>[0];
    expect(holds(meta)).toBe(false);
    payments.paying.add("x");
    expect(holds(meta)).toBe(true);
  });

  it("refuses to start with a hub key zoldSeller would refuse", () => {
    expect(() => openHubPayments(X402, { ...HUB, key: "zsk_short" }, dir)).toThrow(/apiKey/);
  });
});
