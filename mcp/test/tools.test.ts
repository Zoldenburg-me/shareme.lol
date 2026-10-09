import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient, SharedLink } from "../src/client.js";
import type { McpConfig } from "../src/config.js";
import { createShareTools } from "../src/tools.js";

const link: SharedLink = {
  id: "AAAAAAAAAAAAAAAAAAAAAA",
  url: "https://share.example.com/f/AAAAAAAAAAAAAAAAAAAAAA/report.html",
  filename: "report.html",
  size: 4,
  expiresAt: "2026-10-06T12:00:00.000Z",
};

describe("share tools", () => {
  let dir: string;
  let config: McpConfig;
  let client: { [K in keyof HostClient]: ReturnType<typeof vi.fn> };
  const policy = { allowedExtensions: ["html", "md", "txt"], maxFileBytes: 1000, maxTtlSeconds: 86_400 };

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "share-tools-")));
    await writeFile(join(dir, "report.html"), "<p/>");
    config = { hostUrl: "https://h", apiToken: "t", allowedDirs: [dir], defaultTtlHours: 24, maxFileBytes: 100 };
    client = {
      upload: vi.fn().mockResolvedValue(link),
      list: vi.fn().mockResolvedValue([link]),
      revoke: vi.fn(),
      getConfig: vi.fn().mockResolvedValue(policy),
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tools = () => createShareTools(config, client as unknown as HostClient);

  it("share_file uploads with inferred content type and requested TTL", async () => {
    const result = await tools().shareFile({ path: join(dir, "report.html"), ttl_hours: 2 });

    expect(client.upload).toHaveBeenCalledWith({
      body: expect.any(Readable),
      size: 4,
      filename: "report.html",
      ttlSeconds: 7200,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(link.url);
    expect(result.structuredContent).toEqual(link);
  });

  it("share_file leads with the short link and still gives the full one", async () => {
    const shortLink = { ...link, shortUrl: "https://share.example.com/r/Xk3p9Qa2Lm" };
    client.upload.mockResolvedValue(shortLink);
    const text = (await tools().shareFile({ path: join(dir, "report.html") })).content[0].text;
    expect(text.indexOf(shortLink.shortUrl)).toBeGreaterThan(-1);
    expect(text.indexOf(shortLink.shortUrl)).toBeLessThan(text.indexOf(link.url));
  });

  it("list_links shows the short link when the host gives one", async () => {
    client.list.mockResolvedValue([{ ...link, shortUrl: "https://share.example.com/r/Xk3p9Qa2Lm" }]);
    expect((await tools().listLinks()).content[0].text).toContain("https://share.example.com/r/Xk3p9Qa2Lm");
  });

  it("share_file uses the default TTL and an optional display name", async () => {
    await tools().shareFile({ path: join(dir, "report.html"), filename: "Q3 Report.html" });
    expect(client.upload).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: 86_400, filename: "Q3 Report.html" }));
  });

  it("share_file refuses file types the host does not allow, without uploading", async () => {
    await writeFile(join(dir, "run.sh"), "echo hi");
    const result = await tools().shareFile({ path: join(dir, "run.sh") });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("File type .sh is not allowed by the share host. Allowed: .html, .md, .txt");
    expect(client.upload).not.toHaveBeenCalled();
  });

  it("share_file checks the type of the name the recipient will see", async () => {
    const result = await tools().shareFile({ path: join(dir, "report.html"), filename: "report.exe" });
    expect(result.content[0].text).toMatch(/\.exe is not allowed/);
    expect(client.upload).not.toHaveBeenCalled();
  });

  it("share_file fetches the host policy once and reuses it", async () => {
    const t = tools();
    await t.shareFile({ path: join(dir, "report.html") });
    await t.shareFile({ path: join(dir, "report.html") });
    expect(client.getConfig).toHaveBeenCalledTimes(1);
  });

  it("share_file retries fetching the policy after a failure", async () => {
    client.getConfig.mockRejectedValueOnce(new Error("Could not reach share host"));
    const t = tools();
    expect(await t.shareFile({ path: join(dir, "report.html") })).toMatchObject({ isError: true });
    expect((await t.shareFile({ path: join(dir, "report.html") })).isError).toBeFalsy();
    expect(client.getConfig).toHaveBeenCalledTimes(2);
  });

  it("share_file refuses files outside the allowlist without uploading", async () => {
    const result = await tools().shareFile({ path: "/etc/hosts" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outside/);
    expect(client.upload).not.toHaveBeenCalled();
  });

  it("share_file refuses files containing credentials without uploading", async () => {
    // Assembled at runtime so leak scanners don't flag the fixture itself.
    await writeFile(join(dir, "notes.txt"), ["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].join(""));
    const result = await tools().shareFile({ path: join(dir, "notes.txt") });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/private key/);
    expect(client.upload).not.toHaveBeenCalled();
  });

  it("share_file never asks the host for a zero-second TTL", async () => {
    await tools().shareFile({ path: join(dir, "report.html"), ttl_hours: 0.00001 });
    expect(client.upload).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: 1 }));
  });

  it("share_file refuses files over the local size limit", async () => {
    await writeFile(join(dir, "big.txt"), "x".repeat(101));
    const result = await tools().shareFile({ path: join(dir, "big.txt") });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/limit/);
  });

  it("share_file reports host failures as tool errors", async () => {
    client.upload.mockRejectedValue(new Error("Host returned 503"));
    const result = await tools().shareFile({ path: join(dir, "report.html") });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("503") }] });
  });

  it("list_links returns active links", async () => {
    const result = await tools().listLinks();
    expect(result.structuredContent).toEqual({ links: [link] });
    expect(result.content[0].text).toContain(link.url);
  });

  it("list_links says when there are none", async () => {
    client.list.mockResolvedValue([]);
    expect((await tools().listLinks()).content[0].text).toMatch(/no active/i);
  });

  it("revoke_link revokes by id", async () => {
    const result = await tools().revokeLink({ id: link.id });
    expect(client.revoke).toHaveBeenCalledWith(link.id);
    expect(result.content[0].text).toMatch(/revoked/i);
  });

  it("revoke_link reports failures", async () => {
    client.revoke.mockRejectedValue(new Error("Link not found"));
    expect(await tools().revokeLink({ id: "x" })).toMatchObject({ isError: true });
  });
});
