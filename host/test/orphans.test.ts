import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeOrphanedFiles } from "../src/orphans.js";
import { FileStore } from "../src/store.js";
import { TokenStore } from "../src/tokens.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");

describe("purgeOrphanedFiles", () => {
  let dir: string;
  let store: FileStore;
  let tokens: TokenStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-orphans-"));
    store = await FileStore.open(dir);
    tokens = await TokenStore.open(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const put = (owner?: string) =>
    store.create({ filename: "a.txt", contentType: "text/plain", ttlSeconds: 60, maxBytes: 1024, body: Readable.from(["x"]), clock: () => NOW, owner });

  it("removes files of revoked tokens and keeps live and admin files", async () => {
    const { record } = await tokens.issue(NOW);
    const live = await put(record.id);
    const gone = await put("tok_revoked");
    const admin = await put();

    expect(await purgeOrphanedFiles(store, tokens)).toBe(1);

    expect(store.get(live.id, NOW)).toBeDefined();
    expect(store.get(admin.id, NOW)).toBeDefined();
    expect(store.get(gone.id, NOW)).toBeUndefined();
  });

  it("deletes nothing when the token registry is empty (a missing tokens.json must not wipe user files)", async () => {
    const file = await put("tok_someone");

    expect(await purgeOrphanedFiles(store, tokens)).toBe(0);

    expect(store.get(file.id, NOW)).toBeDefined();
  });
});
