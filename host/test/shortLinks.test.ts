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

describe("short links", () => {
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
      shortLinkMissesPerIpPerHour: 100,
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
    const upload = (token: string) =>
    fetch(`${base}/api/files`, { method: "POST", headers: { ...bearer(token), "x-filename": "a.md" }, body: "# hi" });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-short-"));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  type Link = { id: string; url: string; shortUrl: string };
  const share = async () => (await (await upload(ADMIN)).json()) as Link;
  const open = (path: string, ip = "203.0.113.1", method = "GET") =>
    fetch(`${base}${path}`, { method, redirect: "manual", headers: from(ip) });

  it("returns a short link next to the full one on upload and in the file list", async () => {
    await start({});
    const link = await share();
    expect(link.shortUrl).toMatch(/^https:\/\/shareme\.lol\/r\/[A-Za-z0-9]{10}$/);
    expect(link.url).toMatch(/\/f\/[A-Za-z0-9_-]{22}\/a\.md$/);
    const list = (await (await fetch(`${base}/api/files`, { headers: bearer(ADMIN) })).json()) as { files: Link[] };
    expect(list.files[0].shortUrl).toBe(link.shortUrl);
  });

  it("redirects a short link to the file with a temporary, uncached redirect", async () => {
    await start({});
    const link = await share();
    for (const method of ["GET", "HEAD"]) {
      const res = await open(new URL(link.shortUrl).pathname, undefined, method);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(new URL(link.url).pathname);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("shows the link-gone page once the file is revoked", async () => {
    await start({});
    const link = await share();
    await fetch(`${base}/api/files/${link.id}`, { method: "DELETE", headers: bearer(ADMIN) });
    const res = await open(new URL(link.shortUrl).pathname);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("limits wrong short codes per IP, without blocking other IPs", async () => {
    await start({ shortLinkMissesPerIpPerHour: 2 });
    const link = await share();
    const shortPath = new URL(link.shortUrl).pathname;
    expect((await open("/r/AAAAAAAAAA")).status).toBe(404);
    expect((await open("/r/AAAAAAAAAB")).status).toBe(404);
    const blocked = await open("/r/AAAAAAAAAC");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
    // A locked-out IP can't keep guessing, even when it lands on a real code.
    expect((await open(shortPath)).status).toBe(429);
    expect((await open(shortPath, "198.51.100.7")).status).toBe(302);
  });

  it("does not count working short links toward the limit", async () => {
    await start({ shortLinkMissesPerIpPerHour: 1 });
    const shortPath = new URL((await share()).shortUrl).pathname;
    for (let i = 0; i < 3; i++) expect((await open(shortPath)).status).toBe(302);
  });

  it("treats malformed codes as unknown pages", async () => {
    await start({});
    expect((await open("/r/short")).status).toBe(404);
    expect((await open("/r/AAAAAAAAAA/extra")).status).toBe(404);
  });
});
