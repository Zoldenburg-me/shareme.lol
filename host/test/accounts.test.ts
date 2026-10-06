import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/app.js";
import type { HostConfig } from "../src/config.js";
import { SignupLimiter } from "../src/signupLimiter.js";
import { FileStore } from "../src/store.js";
import { TokenStore } from "../src/tokens.js";

const ADMIN = "a".repeat(40);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("self-service accounts", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let config: HostConfig;

  const start = async (overrides: Partial<HostConfig> = {}, limiter = new SignupLimiter(100, 1000)) => {
    config = {
      apiToken: ADMIN,
      publicBaseUrl: "https://shareme.lol",
      dataDir: dir,
      port: 0,
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 7200,
      maxFileBytes: 1000,
      landingPage: "site/index.html",
      maxTotalBytes: 10_000,
      sweepIntervalMs: 60_000,
      allowedExtensions: ["md", "txt"],
      openSignup: true,
      tokenQuotaBytes: 10,
      signupsPerIpPerHour: 100,
      signupsPerDay: 1000,
      trustCfConnectingIp: true,
      apiRequestsPerIpPerMinute: 120,
      authFailuresPerIpPerHour: 30,
      uploadsPerTokenPerHour: 60,
      downloadsPerIpPerMinute: 300,
      ...overrides,
    };
    server = createServer(config, await FileStore.open(dir), Date.now, undefined, { tokens: await TokenStore.open(dir), limiter });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  const signup = (ip = "203.0.113.1") => fetch(`${base}/api/tokens`, { method: "POST", headers: { "cf-connecting-ip": ip } });
  const newToken = async () => ((await (await signup()).json()) as { token: string; id: string });
  const upload = (token: string, body: string, name = "a.md") =>
    fetch(`${base}/api/files`, { method: "POST", headers: { ...bearer(token), "x-filename": name }, body });
  const list = async (token: string) => ((await (await fetch(`${base}/api/files`, { headers: bearer(token) })).json()) as { files: { id: string }[] }).files;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-acct-"));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("issues a token to anyone, uncached, with this host's limits", async () => {
    await start();
    const res = await signup();
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ host: "https://shareme.lol", quotaBytes: 10, maxFileBytes: 1000, maxTtlSeconds: 7200, allowedExtensions: ["md", "txt"] });
    expect(body.token).toMatch(/^sm_/);
    expect(body.id).toMatch(/^tok_/);
  });

  it("lets a new token upload, and scopes listing and revoking to its own links", async () => {
    await start();
    const alice = await newToken();
    const bob = await newToken();
    const a = await (await upload(alice.token, "hi")).json();
    await upload(bob.token, "yo");

    expect((await list(alice.token)).map((f) => f.id)).toEqual([a.id]);
    expect(await list(ADMIN)).toHaveLength(2);
    expect((await fetch(`${base}/api/files/${a.id}`, { method: "DELETE", headers: bearer(bob.token) })).status).toBe(404);
    expect((await fetch(`${base}/api/files/${a.id}`, { method: "DELETE", headers: bearer(alice.token) })).status).toBe(204);
  });

  it("enforces the per-token storage quota and reports usage", async () => {
    await start();
    const { token, id } = await newToken();
    expect((await upload(token, "12345678")).status).toBe(201);
    const over = await upload(token, "12345");
    expect(over.status).toBe(507);
    expect((await over.json()).error).toMatch(/quota/i);
    const cfg = await (await fetch(`${base}/api/config`, { headers: bearer(token) })).json();
    expect(cfg.account).toEqual({ id, usedBytes: 8, quotaBytes: 10 });
  });

  it("lets the admin revoke a token, deleting its files", async () => {
    await start();
    const { token, id } = await newToken();
    const other = await newToken();
    const { url } = await (await upload(token, "hi")).json();
    expect((await fetch(`${base}/api/tokens/${id}`, { method: "DELETE", headers: bearer(other.token) })).status).toBe(403);
    expect((await fetch(`${base}/api/tokens/${id}`, { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(204);
    expect((await fetch(`${base}/api/files`, { headers: bearer(token) })).status).toBe(401);
    expect((await fetch(`${base}${new URL(url).pathname}`)).status).toBe(404);
  });

  it("lets a token delete itself and its files", async () => {
    await start();
    const { token } = await newToken();
    await upload(token, "hi");
    expect((await fetch(`${base}/api/tokens/me`, { method: "DELETE", headers: bearer(token) })).status).toBe(204);
    expect((await fetch(`${base}/api/files`, { headers: bearer(token) })).status).toBe(401);
    expect(await list(ADMIN)).toHaveLength(0);
  });

  it("rate-limits signups per client IP", async () => {
    await start({}, new SignupLimiter(1, 1000));
    expect((await signup("198.51.100.7")).status).toBe(201);
    const limited = await signup("198.51.100.7");
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/try again/i);
    expect((await signup("198.51.100.8")).status).toBe(201);
  });

  it("ignores CF-Connecting-IP unless told to trust it", async () => {
    await start({ trustCfConnectingIp: false }, new SignupLimiter(1, 1000));
    expect((await signup("198.51.100.1")).status).toBe(201);
    expect((await signup("198.51.100.2")).status).toBe(429);
  });

  it("refuses signups when open signup is off", async () => {
    await start({ openSignup: false });
    expect((await signup()).status).toBe(403);
  });
});
