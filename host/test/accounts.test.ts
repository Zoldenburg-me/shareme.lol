import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
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
      shortLinkMissesPerIpPerHour: 60,
      maxFilesPerToken: 200,
      concurrentUploadsPerToken: 2,
      minUploadBytesPerSecond: 1024,
      uploadPaceWindowMs: 10_000,
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
    expect(cfg.account).toEqual({ id, plan: "free", usedBytes: 8, quotaBytes: 10 });
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

  it("drops an upload that finishes after its token was revoked", async () => {
    await start({ tokenQuotaBytes: 1000 });
    const { token } = await newToken();
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { push = c; } });
    // More than the 512-byte content sniff, so the server gets past it and starts writing.
    push.enqueue(new TextEncoder().encode("x".repeat(600)));
    const pending = fetch(`${base}/api/files`, {
      method: "POST",
      headers: { ...bearer(token), "x-filename": "late.md" },
      body,
      duplex: "half",
    } as RequestInit);
    // Wait until the server is writing the blob, so the revoke really lands mid-upload
    // (a revoke before authentication would also give 401 and prove nothing).
    for (let i = 0; i < 100 && (await readdir(join(dir, "files")).catch(() => [])).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await readdir(join(dir, "files"))).toHaveLength(1);
    expect((await fetch(`${base}/api/tokens/me`, { method: "DELETE", headers: bearer(token) })).status).toBe(204);
    push.close();

    expect((await pending).status).toBe(401);
    expect(await list(ADMIN)).toHaveLength(0);
  });

  /** An upload that declares `length` bytes but sends only `first` until finish() is called. */
  const startUpload = (token: string, length: number, first: string) => {
    const req = request(`${base}/api/files`, {
      method: "POST",
      headers: { ...bearer(token), "x-filename": "slow.md", "content-length": String(length) },
    });
    const status = new Promise<number>((resolve, reject) => {
      req.on("response", (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
    });
    req.write(first);
    return { finish: (rest: string) => req.end(rest), status };
  };
  const waitForBlob = async () => {
    for (let i = 0; i < 100 && (await readdir(join(dir, "files")).catch(() => [])).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await readdir(join(dir, "files"))).toHaveLength(1);
  };

  it("counts uploads still in progress against the token quota", async () => {
    await start({ tokenQuotaBytes: 1000 });
    const { token } = await newToken();
    // Past the 512-byte content sniff, so the server is writing it when the second upload arrives.
    const slow = startUpload(token, 600, "x".repeat(550));
    await waitForBlob();
    const parallel = await upload(token, "y".repeat(600));
    expect(parallel.status).toBe(507);
    expect((await parallel.json()).error).toMatch(/quota/i);
    slow.finish("x".repeat(50));
    expect(await slow.status).toBe(201);
    expect((await upload(token, "z".repeat(400))).status).toBe(201);
    expect((await upload(token, "z")).status).toBe(507);
  });

  it("counts uploads still in progress against the host-wide cap", async () => {
    await start({ maxTotalBytes: 1000 });
    const slow = startUpload(ADMIN, 600, "x".repeat(550));
    await waitForBlob();
    const parallel = await upload(ADMIN, "y".repeat(600));
    expect(parallel.status).toBe(507);
    expect((await parallel.json()).error).toMatch(/storage is full/);
    slow.finish("x".repeat(50));
    expect(await slow.status).toBe(201);
  });

  it("holds a chunked upload's whole allowance while it streams, since its size is unknown", async () => {
    await start({ tokenQuotaBytes: 1000 });
    const { token } = await newToken();
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { push = c; } });
    push.enqueue(new TextEncoder().encode("x".repeat(550)));
    const chunked = fetch(`${base}/api/files`, {
      method: "POST",
      headers: { ...bearer(token), "x-filename": "chunked.md" },
      body,
      duplex: "half",
    } as RequestInit);
    await waitForBlob();
    expect((await upload(token, "y")).status).toBe(507);
    push.close();
    expect((await chunked).status).toBe(201);
    // Once stored, only its real size counts.
    expect((await upload(token, "y".repeat(450))).status).toBe(201);
  });

  it("counts uploads still in progress toward the file cap", async () => {
    await start({ tokenQuotaBytes: 1000, maxFilesPerToken: 1 });
    const { token } = await newToken();
    const slow = startUpload(token, 600, "x".repeat(550));
    await waitForBlob();
    const parallel = await upload(token, "y");
    expect(parallel.status).toBe(507);
    expect((await parallel.json()).error).toMatch(/1 files/);
    slow.finish("x".repeat(50));
    expect(await slow.status).toBe(201);
  });

  it("gives the space back when the client drops mid-upload", async () => {
    await start({ tokenQuotaBytes: 1000 });
    const { token } = await newToken();
    const req = request(`${base}/api/files`, {
      method: "POST",
      headers: { ...bearer(token), "x-filename": "dropped.md", "content-length": "900" },
    });
    req.on("error", () => undefined);
    req.write("x".repeat(550));
    await waitForBlob();
    req.destroy();
    // The aborted upload's directory is removed and its 900 bytes released.
    for (let i = 0; i < 100 && (await readdir(join(dir, "files"))).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await upload(token, "z".repeat(900))).status).toBe(201);
  });

  it("caps uploads in progress per token, without spending the hourly allowance on refusals", async () => {
    await start({ tokenQuotaBytes: 1000, concurrentUploadsPerToken: 1, uploadsPerTokenPerHour: 2 });
    const { token } = await newToken();
    const slow = startUpload(token, 600, "x".repeat(550));
    await waitForBlob();
    const busy = await upload(token, "y");
    expect(busy.status).toBe(429);
    expect(Number(busy.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await busy.json()).error).toMatch(/in progress/);
    expect((await upload(ADMIN, "the admin token has no concurrency cap")).status).toBe(201);
    slow.finish("x".repeat(50));
    expect(await slow.status).toBe(201);
    // The refused request was not counted: the second of two hourly uploads still goes through.
    expect((await upload(token, "y")).status).toBe(201);
  });

  it("aborts an upload that stalls, even after a fast start, and frees its space", async () => {
    // 100 bytes per 100 ms window.
    await start({ tokenQuotaBytes: 1000, minUploadBytesPerSecond: 1000, uploadPaceWindowMs: 100 });
    const { token } = await newToken();
    const stalled = startUpload(token, 900, "x".repeat(550));
    expect(await stalled.status).toBe(408);
    expect((await upload(token, "z".repeat(900))).status).toBe(201);
  });

  it("lets a slow upload through while it keeps up the minimum pace", async () => {
    await start({ tokenQuotaBytes: 1000, minUploadBytesPerSecond: 1000, uploadPaceWindowMs: 100 });
    const { token } = await newToken();
    const req = request(`${base}/api/files`, {
      method: "POST",
      headers: { ...bearer(token), "x-filename": "steady.md", "content-length": "900" },
    });
    const status = new Promise<number>((resolve, reject) => {
      req.on("response", (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
    });
    // 150 bytes every 50 ms: several windows long, never under 100 bytes per window.
    for (let sent = 0; sent < 900; sent += 150) {
      req.write("x".repeat(150));
      await new Promise((r) => setTimeout(r, 50));
    }
    req.end();
    expect(await status).toBe(201);
  });

  it("gives the space back when an upload is refused", async () => {
    await start({ tokenQuotaBytes: 1000 });
    const { token } = await newToken();
    expect((await upload(token, `\0${"x".repeat(899)}`)).status).toBe(415);
    expect((await upload(token, "x".repeat(900))).status).toBe(201);
  });

  it("refuses empty uploads, with or without a Content-Length", async () => {
    await start();
    const { token } = await newToken();
    const declared = await upload(token, "");
    expect(declared.status).toBe(400);
    expect((await declared.json()).error).toMatch(/empty/);
    const chunked = await fetch(`${base}/api/files`, {
      method: "POST",
      headers: { ...bearer(token), "x-filename": "a.md" },
      body: new ReadableStream({ start: (c) => c.close() }),
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(400);
    expect(await readdir(join(dir, "files"))).toHaveLength(0);
  });

  it("caps how many files one token can have shared at once", async () => {
    await start({ tokenQuotaBytes: 1000, maxFilesPerToken: 2 });
    const { token } = await newToken();
    const first = (await (await upload(token, "a")).json()) as { id: string };
    expect((await upload(token, "b")).status).toBe(201);
    const over = await upload(token, "c");
    expect(over.status).toBe(507);
    expect((await over.json()).error).toMatch(/2 files/);
    expect((await upload(ADMIN, "the admin token has no file cap")).status).toBe(201);
    expect((await fetch(`${base}/api/files/${first.id}`, { method: "DELETE", headers: bearer(token) })).status).toBe(204);
    expect((await upload(token, "c")).status).toBe(201);
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
