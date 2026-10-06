import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore, FileTooLargeError } from "../src/store.js";

const NOW = Date.parse("2026-10-05T12:00:00Z");

describe("FileStore", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-store-"));
    store = await FileStore.open(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const put = (body: string, ttlSeconds = 60, maxBytes = 1024) =>
    store.create({ filename: "a.txt", contentType: "text/plain", ttlSeconds, maxBytes, body: Readable.from([body]), clock: () => NOW });

  it("stores a file with an unguessable id and computed expiry", async () => {
    const meta = await put("hello");

    expect(meta.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(meta.size).toBe(5);
    expect(meta.expiresAt).toBe(NOW + 60_000);
    expect(store.get(meta.id, NOW)).toEqual(meta);
  });

  it("generates distinct ids", async () => {
    const [a, b] = await Promise.all([put("1"), put("2")]);
    expect(a.id).not.toBe(b.id);
  });

  it("rejects bodies over the size limit and leaves nothing on disk", async () => {
    await expect(put("x".repeat(20), 60, 10)).rejects.toBeInstanceOf(FileTooLargeError);
    expect(await readdir(join(dir, "files"))).toEqual([]);
  });

  it("treats expired entries as missing", async () => {
    const meta = await put("hi", 1);
    expect(store.get(meta.id, NOW + 1_001)).toBeUndefined();
  });

  it("returns undefined for malformed ids without touching disk", () => {
    expect(store.get("../../etc/passwd", NOW)).toBeUndefined();
  });

  it("deletes files and reports whether anything was removed", async () => {
    const meta = await put("hi");
    expect(await store.delete(meta.id)).toBe(true);
    expect(await store.delete(meta.id)).toBe(false);
    expect(await readdir(join(dir, "files"))).toEqual([]);
  });

  it("sweeps only expired files", async () => {
    const short = await put("a", 1);
    const long = await put("b", 100);

    const removed = await store.sweep(NOW + 2_000);

    expect(removed).toEqual([short.id]);
    expect(store.list(NOW + 2_000).map((m) => m.id)).toEqual([long.id]);
  });

  it("reloads metadata from disk on reopen", async () => {
    const meta = await put("persist");
    const reopened = await FileStore.open(dir);
    expect(reopened.get(meta.id, NOW)).toEqual(meta);
  });

  it("computes expiry from when the upload finished, not when it started", async () => {
    let clock = NOW;
    async function* slowBody() {
      yield "a";
      clock += 5_000;
      yield "b";
    }
    const meta = await store.create({ filename: "a", contentType: "text/plain", ttlSeconds: 10, maxBytes: 10, body: Readable.from(slowBody()), clock: () => clock });
    expect(meta.expiresAt).toBe(NOW + 5_000 + 10_000);
  });

  it("tracks total stored bytes of live files", async () => {
    await put("12345");
    await put("123");
    expect(store.totalBytes()).toBe(8);
  });

  it("on reopen removes incomplete uploads but keeps dirs whose metadata is unreadable", async () => {
    const files = join(dir, "files");
    const incomplete = "B".repeat(22);
    const corrupt = "C".repeat(22);
    await mkdir(join(files, incomplete));
    await writeFile(join(files, incomplete, "blob.part"), "x");
    await mkdir(join(files, corrupt));
    await writeFile(join(files, corrupt, "meta.json"), "{not json");

    const reopened = await FileStore.open(dir);

    expect((await readdir(files)).sort()).toEqual([corrupt]);
    expect(reopened.list(NOW)).toEqual([]);
  });

  it("records the owner and scopes listing, usage and bulk deletion to it", async () => {
    const mk = (owner: string | undefined, body: string) =>
      store.create({ filename: "a.txt", contentType: "text/plain", ttlSeconds: 60, maxBytes: 1024, body: Readable.from([body]), clock: () => NOW, owner });
    const a1 = await mk("tok_a", "12345");
    await mk("tok_a", "123");
    const b1 = await mk("tok_b", "1");
    const admin = await mk(undefined, "12");

    expect(a1.owner).toBe("tok_a");
    expect(admin.owner).toBeUndefined();
    expect(store.usedBytes("tok_a")).toBe(8);
    expect(store.list(NOW, "tok_b").map((m) => m.id)).toEqual([b1.id]);
    expect(store.list(NOW)).toHaveLength(4);

    expect(await store.deleteByOwner("tok_a")).toBe(2);
    expect(store.usedBytes("tok_a")).toBe(0);
    expect(store.list(NOW)).toHaveLength(2);
  });

  it("opens a readable stream of the stored bytes", async () => {
    const meta = await put("stream me");
    const chunks: Buffer[] = [];
    for await (const c of store.openBlob(meta.id)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("stream me");
  });
});
