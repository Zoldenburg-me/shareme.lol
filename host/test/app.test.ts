import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/app.js";
import type { HostConfig } from "../src/config.js";
import { FileStore } from "../src/store.js";

const TOKEN = "t".repeat(40);
const AUTH = { authorization: `Bearer ${TOKEN}` };

describe("host HTTP API", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let clock: number;
  let config: HostConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-app-"));
    clock = Date.parse("2026-10-05T12:00:00Z");
    config = {
      apiToken: TOKEN,
      publicBaseUrl: "https://share.example.com",
      dataDir: dir,
      port: 0,
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 7200,
      maxFileBytes: 64,
      maxTotalBytes: 100,
      sweepIntervalMs: 60_000,
      allowedExtensions: ["md", "png", "txt"],
      openSignup: false,
      tokenQuotaBytes: 1024 * 1024,
      signupsPerIpPerHour: 5,
      signupsPerDay: 500,
      trustCfConnectingIp: false,
      apiRequestsPerIpPerMinute: 120,
      authFailuresPerIpPerHour: 30,
      uploadsPerTokenPerHour: 60,
      downloadsPerIpPerMinute: 300,
    };
    server = createServer(config, await FileStore.open(dir), () => clock, {
      landing: "<!doctype html><title>landing</title>",
      setup: "# share-me setup",
      legal: { imprint: "<title>imprint</title>", privacy: "<title>privacy</title>" },
      fonts: new Map([["dm-sans.woff2", Buffer.from("wOF2font")]]),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  const upload = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/files`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "text/plain", "x-filename": encodeURIComponent("report é.txt"), ...headers },
      body,
    });

  it("serves the landing page at the root", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("font-src 'self'");
    expect(res.headers.get("content-security-policy")).not.toContain("google");
    expect(await res.text()).toContain("<title>landing</title>");
    expect((await fetch(`${base}/`, { method: "HEAD" })).status).toBe(200);
  });

  it("serves the agent setup guide as markdown at /setup and /llms.txt", async () => {
    for (const path of ["/setup", "/llms.txt"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(await res.text()).toBe("# share-me setup");
    }
  });

  it("serves the imprint and privacy policy in English and German paths", async () => {
    const expected = { "/imprint": "imprint", "/impressum": "imprint", "/privacy": "privacy", "/datenschutz": "privacy" };
    for (const [path, title] of Object.entries(expected)) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toBe(`<title>${title}</title>`);
    }
  });

  it("serves its own fonts with a long cache lifetime", async () => {
    const res = await fetch(`${base}/fonts/dm-sans.woff2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe("wOF2font");
    expect((await fetch(`${base}/fonts/missing.woff2`)).status).toBe(404);
  });

  it("has no legal pages on a host that does not publish them", async () => {
    const bare = createServer(config, await FileStore.open(dir), () => clock, { landing: "", setup: "" });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/imprint`);
      expect(res.status).toBe(404);
    } finally {
      bare.closeAllConnections();
      await new Promise((r) => bare.close(r));
    }
  });

  it("answers health checks", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
  });

  it("uploads a file and serves it at the returned public URL", async () => {
    const res = await upload("hello world", { "x-ttl-seconds": "600" });
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.url).toMatch(/^https:\/\/share\.example\.com\/f\/[A-Za-z0-9_-]{22}\/report%20%C3%A9\.txt$/);
    expect(body.expiresAt).toBe(new Date(clock + 600_000).toISOString());

    const path = new URL(body.url).pathname;
    const dl = await fetch(`${base}${path}`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("hello world");
    expect(dl.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(dl.headers.get("content-security-policy")).toContain("sandbox");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''report%20%C3%A9.txt");
  });

  it("sandboxes served files and forbids framing", async () => {
    const { url } = await (await upload("a")).json();
    const dl = await fetch(`${base}${new URL(url).pathname}`);
    expect(dl.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("answers HEAD on a file without a body", async () => {
    const { url } = await (await upload("hello")).json();
    const res = await fetch(`${base}${new URL(url).pathname}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("5");
    expect(await res.text()).toBe("");
  });

  it("returns 507 once the storage quota is used up", async () => {
    expect((await upload("x".repeat(60))).status).toBe(201);
    expect((await upload("x".repeat(50))).status).toBe(507);
    expect((await upload("x".repeat(40))).status).toBe(201);
  });

  it("still delivers a 401 when a large body is streamed with a bad token", async () => {
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= 8 * 1024 * 1024) return controller.close();
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const res = await fetch(`${base}/api/files`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "x-filename": "big.bin" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(401);
  });

  it("sets explicit server timeouts suitable for large uploads", () => {
    expect(server.requestTimeout).toBe(30 * 60_000);
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it("uses the default TTL and clamps to the max TTL", async () => {
    const def = await (await upload("a")).json();
    expect(def.expiresAt).toBe(new Date(clock + 3_600_000).toISOString());

    const clamped = await (await upload("a", { "x-ttl-seconds": "999999" })).json();
    expect(clamped.expiresAt).toBe(new Date(clock + 7_200_000).toISOString());
  });

  it("rejects uploads without a valid bearer token", async () => {
    expect((await upload("a", { authorization: "" })).status).toBe(401);
    expect((await upload("a", { authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("rejects bad TTLs, missing filenames and oversize bodies", async () => {
    expect((await upload("a", { "x-ttl-seconds": "abc" })).status).toBe(400);
    expect((await upload("a", { "x-filename": "" })).status).toBe(400);
    expect((await upload("x".repeat(100))).status).toBe(413);
  });

  it("derives the served content type from the extension, ignoring the uploader's header", async () => {
    const { url } = await (await upload("a", { "content-type": "text/html" })).json();
    const dl = await fetch(`${base}${new URL(url).pathname}`);
    expect(dl.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("rejects file types that are not on the allowlist with 415", async () => {
    const exe = await upload("MZ", { "x-filename": "setup.exe" });
    expect(exe.status).toBe(415);
    expect((await exe.json()).error).toMatch(/\.exe.*allowed: \.md, \.png, \.txt/i);

    const knownButNotAllowed = await upload("%PDF-1.7", { "x-filename": "doc.pdf" });
    expect(knownButNotAllowed.status).toBe(415);

    expect((await upload("a", { "x-filename": "README" })).status).toBe(415);
  });

  it("rejects content that does not match its extension with 415", async () => {
    const res = await upload("this is not a png", { "x-filename": "chart.png" });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/does not look like a \.png/);
    expect((await fetch(`${base}/api/files`, { headers: AUTH }).then((r) => r.json())).files).toEqual([]);
  });

  it("accepts content that matches its extension", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const res = await fetch(`${base}/api/files`, {
      method: "POST",
      headers: { ...AUTH, "x-filename": "chart.png" },
      body: png,
    });
    expect(res.status).toBe(201);
    const dl = await fetch(`${base}${new URL((await res.json()).url).pathname}`);
    expect(dl.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await dl.arrayBuffer())).toEqual(png);
  });

  it("publishes the upload policy to authenticated clients", async () => {
    expect((await fetch(`${base}/api/config`)).status).toBe(401);
    const res = await fetch(`${base}/api/config`, { headers: AUTH });
    expect(await res.json()).toEqual({ allowedExtensions: ["md", "png", "txt"], maxFileBytes: 64, maxTtlSeconds: 7200 });
  });

  it("lists and revokes links", async () => {
    const { id } = await (await upload("a")).json();

    const list = await (await fetch(`${base}/api/files`, { headers: AUTH })).json();
    expect(list.files.map((f: { id: string }) => f.id)).toEqual([id]);

    const del = await fetch(`${base}/api/files/${id}`, { method: "DELETE", headers: AUTH });
    expect(del.status).toBe(204);
    expect((await fetch(`${base}/f/${id}/x`)).status).toBe(404);
    expect((await fetch(`${base}/api/files/${id}`, { method: "DELETE", headers: AUTH })).status).toBe(404);
  });

  it("requires auth for list and revoke", async () => {
    expect((await fetch(`${base}/api/files`)).status).toBe(401);
    expect((await fetch(`${base}/api/files/abc`, { method: "DELETE" })).status).toBe(401);
  });

  it("returns 404 once a link has expired", async () => {
    const { url } = await (await upload("a", { "x-ttl-seconds": "1" })).json();
    clock += 2_000;
    expect((await fetch(`${base}${new URL(url).pathname}`)).status).toBe(404);
  });

  it("returns 404 for unknown routes and ids", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/f/AAAAAAAAAAAAAAAAAAAAAA/x`)).status).toBe(404);
  });
});
