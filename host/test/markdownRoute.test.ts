import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/app.js";
import type { HostConfig } from "../src/config.js";
import { MARKDOWN_RENDER_MAX_BYTES } from "../src/markdownView.js";
import { FileStore } from "../src/store.js";

const TOKEN = "t".repeat(40);

describe("markdown downloads", () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-md-"));
    const config: HostConfig = {
      apiToken: TOKEN,
      publicBaseUrl: "https://share.example.com",
      dataDir: dir,
      port: 0,
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 7200,
      maxFileBytes: MARKDOWN_RENDER_MAX_BYTES * 2,
      maxTotalBytes: MARKDOWN_RENDER_MAX_BYTES * 4,
      sweepIntervalMs: 60_000,
      allowedExtensions: ["md", "txt"],
      openSignup: false,
      tokenQuotaBytes: MARKDOWN_RENDER_MAX_BYTES * 4,
      signupsPerIpPerHour: 5,
      signupsPerDay: 500,
      trustCfConnectingIp: false,
      apiRequestsPerIpPerMinute: 120,
      authFailuresPerIpPerHour: 30,
      uploadsPerTokenPerHour: 60,
      downloadsPerIpPerMinute: 300,
      shortLinkMissesPerIpPerHour: 60,
      maxFilesPerToken: 200,
      concurrentUploadsPerToken: 2,
      minUploadBytesPerSecond: 1024,
      uploadPaceWindowMs: 10_000,
    };
    server = createServer(config, await FileStore.open(dir), Date.now, { landing: "<title>landing</title>", setup: "# setup" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  async function share(filename: string, body: string): Promise<string> {
    const res = await fetch(`${base}/api/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain", "x-filename": encodeURIComponent(filename) },
      body,
    });
    expect(res.status).toBe(201);
    const { url } = (await res.json()) as { url: string };
    return url.replace("https://share.example.com", base);
  }

  it("renders markdown as a sandboxed HTML page", async () => {
    const url = await share("notes.md", "# Hello\n\n<script>alert(1)</script>\n");
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox; default-src 'none'/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toContain("<h1>Hello</h1>");
    expect(body).not.toContain("<script>");
    expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(body));
  });

  it("serves the original file with ?raw", async () => {
    const url = await share("notes.md", "# Hello\n");
    const res = await fetch(`${url}?raw=1`);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("notes.md");
    expect(await res.text()).toBe("# Hello\n");
  });

  it("answers HEAD for rendered markdown without a body", async () => {
    const url = await share("notes.md", "# Hello\n");
    const res = await fetch(url, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("");
  });

  it("serves markdown over the render limit raw", async () => {
    const url = await share("big.md", "a".repeat(MARKDOWN_RENDER_MAX_BYTES + 1));
    const res = await fetch(url);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    await res.arrayBuffer();
  });

  it("leaves other text types untouched", async () => {
    const url = await share("notes.txt", "# not markdown\n");
    const res = await fetch(url);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("# not markdown\n");
  });
});
