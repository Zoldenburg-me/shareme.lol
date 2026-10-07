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

describe("request rate limits", () => {
  let dir: string;
  let server: Server;
  let base: string;

  const start = async (overrides: Partial<HostConfig>) => {
    const config: HostConfig = {
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
      tokenQuotaBytes: 1000,
      signupsPerIpPerHour: 100,
      signupsPerDay: 1000,
      trustCfConnectingIp: true,
      apiRequestsPerIpPerMinute: 100,
      authFailuresPerIpPerHour: 100,
      uploadsPerTokenPerHour: 100,
      downloadsPerIpPerMinute: 100,
      maxFilesPerToken: 200,
      concurrentUploadsPerToken: 2,
      minUploadBytesPerSecond: 1024,
      uploadPaceWindowMs: 10_000,
      ...overrides,
    };
    const accounts = { tokens: await TokenStore.open(dir), limiter: new SignupLimiter(100, 1000) };
    server = createServer(config, await FileStore.open(dir), Date.now, undefined, accounts);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  const from = (ip: string) => ({ "cf-connecting-ip": ip });
  const getConfig = (token: string, ip = "203.0.113.1") => fetch(`${base}/api/config`, { headers: { ...bearer(token), ...from(ip) } });
  const upload = (token: string) =>
    fetch(`${base}/api/files`, { method: "POST", headers: { ...bearer(token), "x-filename": "a.md" }, body: "# hi" });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-rate-"));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("answers 429 with Retry-After once an IP sends too many API requests", async () => {
    await start({ apiRequestsPerIpPerMinute: 2 });
    expect((await getConfig(ADMIN)).status).toBe(200);
    expect((await getConfig(ADMIN)).status).toBe(200);
    const res = await getConfig(ADMIN);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await res.json()).error).toMatch(/slow down/);
    expect((await getConfig(ADMIN, "198.51.100.7")).status).toBe(200);
  });

  it("locks an IP out of wrong tokens, but never refuses a right one from it", async () => {
    await start({ authFailuresPerIpPerHour: 2 });
    expect((await getConfig("wrong")).status).toBe(401);
    expect((await getConfig("wrong")).status).toBe(401);
    const locked = await getConfig("wrong");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).not.toBeNull();
    // Someone else on the same IP or NAT still gets in with a valid token.
    expect((await getConfig(ADMIN)).status).toBe(200);
    expect((await getConfig("wrong", "198.51.100.7")).status).toBe(401);
  });

  it("does not count requests without a token toward the lockout, so other sites can't trigger it", async () => {
    await start({ authFailuresPerIpPerHour: 2 });
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${base}/api/files`, { headers: from("203.0.113.1") })).status).toBe(401);
    }
    expect((await getConfig(ADMIN)).status).toBe(200);
  });

  it("limits uploads per self-service token but not for the admin token", async () => {
    await start({ uploadsPerTokenPerHour: 1 });
    const { token } = (await (await fetch(`${base}/api/tokens`, { method: "POST", headers: from("192.0.2.9") })).json()) as { token: string };
    expect((await upload(token)).status).toBe(201);
    const res = await upload(token);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/1 per hour/);
    expect((await upload(ADMIN)).status).toBe(201);
    expect((await upload(ADMIN)).status).toBe(201);
  });

  it("limits downloads per IP", async () => {
    await start({ downloadsPerIpPerMinute: 1 });
    const { url } = (await (await upload(ADMIN)).json()) as { url: string };
    const path = new URL(url).pathname;
    expect((await fetch(`${base}${path}`, { headers: from("192.0.2.1") })).status).toBe(200);
    expect((await fetch(`${base}${path}`, { headers: from("192.0.2.1") })).status).toBe(429);
    expect((await fetch(`${base}${path}`, { headers: from("192.0.2.2") })).status).toBe(200);
  });
});
