import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../host/src/app.js";
import { FileStore } from "../host/src/store.js";
import { buildServer } from "../mcp/src/server.js";

const TOKEN = "e2e-token-".padEnd(40, "z");

describe("agent → MCP → host → recipient", () => {
  let root: string;
  let outDir: string;
  let host: Server;
  let base: string;
  let client: Client;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "share-e2e-")));
    outDir = join(root, "out");
    await import("node:fs/promises").then((fs) => fs.mkdir(outDir));
    await writeFile(join(outDir, "summary.md"), "# Results\nAll green.");

    host = createServer(
      {
        apiToken: TOKEN,
        publicBaseUrl: "https://share.example.com",
        dataDir: join(root, "data"),
        port: 0,
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 86_400,
        maxFileBytes: 1024 * 1024,
        maxTotalBytes: 10 * 1024 * 1024,
        allowedExtensions: ["html", "md", "txt"],
      openSignup: false,
      tokenQuotaBytes: 1024 * 1024,
      signupsPerIpPerHour: 5,
      signupsPerDay: 500,
      trustCfConnectingIp: false,
      apiRequestsPerIpPerMinute: 120,
      authFailuresPerIpPerHour: 30,
      uploadsPerTokenPerHour: 60,
      downloadsPerIpPerMinute: 300,
        sweepIntervalMs: 60_000,
      },
      await FileStore.open(join(root, "data")),
    );
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;

    const mcp = buildServer({ hostUrl: base, apiToken: TOKEN, allowedDirs: [outDir], defaultTtlHours: 1, maxFileBytes: 1024 * 1024 });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    client = new Client({ name: "test-agent", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
    host.closeAllConnections();
    await new Promise((r) => host.close(r));
    await rm(root, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[]; structuredContent?: any }>;

  it("exposes the three tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_links", "revoke_link", "share_file"]);
  });

  it("shares a file, lets a recipient download it, lists it, then revokes it", async () => {
    const shared = await call("share_file", { path: join(outDir, "summary.md"), ttl_hours: 2 });
    expect(shared.isError).toBeFalsy();
    const link = shared.structuredContent;
    expect(link.url).toMatch(/^https:\/\/share\.example\.com\/f\/[\w-]{22}\/summary\.md$/);

    const page = await fetch(`${base}${new URL(link.url).pathname}`);
    expect(await page.text()).toContain("<h1>Results</h1>");
    const download = await fetch(`${base}${new URL(link.url).pathname}?raw=1`);
    expect(await download.text()).toBe("# Results\nAll green.");
    expect(download.headers.get("content-type")).toBe("text/markdown; charset=utf-8");

    const listed = await call("list_links");
    expect(listed.structuredContent.links.map((l: { id: string }) => l.id)).toEqual([link.id]);

    const revoked = await call("revoke_link", { id: link.id });
    expect(revoked.isError).toBeFalsy();
    expect((await fetch(`${base}${new URL(link.url).pathname}`)).status).toBe(404);
  });

  it("refuses disallowed file types before uploading anything", async () => {
    await writeFile(join(outDir, "tool.sh"), "#!/bin/sh\necho hi");
    const result = await call("share_file", { path: join(outDir, "tool.sh") });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/\.sh.*not allowed.*\.html, \.md, \.txt/);
  });

  it("refuses to share files outside the allowed dir", async () => {
    await writeFile(join(root, "private.txt"), "secret");
    const result = await call("share_file", { path: join(root, "private.txt") });
    expect(result.isError).toBe(true);
  });

  it("surfaces a wrong API token as a tool error", async () => {
    const bad = buildServer({ hostUrl: base, apiToken: "wrong", allowedDirs: [outDir], defaultTtlHours: 1, maxFileBytes: 1024 });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await bad.connect(s);
    const agent = new Client({ name: "bad", version: "0" });
    await agent.connect(c);
    const result = (await agent.callTool({ name: "list_links", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/401/);
    await agent.close();
  });
});
