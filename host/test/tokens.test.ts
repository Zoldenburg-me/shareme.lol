import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenStore } from "../src/tokens.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");

describe("TokenStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-tokens-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("issues unguessable tokens and finds them again", async () => {
    const store = await TokenStore.open(dir);
    const a = await store.issue(NOW);
    const b = await store.issue(NOW);

    expect(a.token).toMatch(/^sm_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.record.id).toMatch(/^tok_[A-Za-z0-9_-]{8}$/);
    expect(store.find(a.token)).toEqual(a.record);
    expect(store.find("sm_nope")).toBeUndefined();
  });

  it("stores only hashes, owner-readable only, and survives a restart", async () => {
    const store = await TokenStore.open(dir);
    const { token, record } = await store.issue(NOW);
    const path = join(dir, "tokens.json");

    expect(await readFile(path, "utf8")).not.toContain(token);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await TokenStore.open(dir)).find(token)).toEqual(record);
  });

  it("keeps every token when many are issued at once", async () => {
    const store = await TokenStore.open(dir);
    const issued = await Promise.all(Array.from({ length: 20 }, () => store.issue(NOW)));
    const reopened = await TokenStore.open(dir);
    expect(issued.every(({ token }) => reopened.find(token))).toBe(true);
    expect(reopened.count()).toBe(20);
  });

  it("revokes a token by id", async () => {
    const store = await TokenStore.open(dir);
    const { token, record } = await store.issue(NOW);
    expect(await store.revoke(record.id)).toBe(true);
    expect(await store.revoke(record.id)).toBe(false);
    expect(store.find(token)).toBeUndefined();
    expect((await TokenStore.open(dir)).find(token)).toBeUndefined();
  });
});

describe("TokenStore plans", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-plans-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sets and clears a token's Pro plan, surviving a restart", async () => {
    const store = await TokenStore.open(dir);
    const { token, record } = await store.issue(NOW);
    const until = NOW + 30 * 86_400_000;

    expect(await store.setPlan(record.id, until)).toEqual({ ...record, plan: { name: "pro", until } });
    expect((await TokenStore.open(dir)).find(token)?.plan).toEqual({ name: "pro", until });

    expect(await store.setPlan(record.id, undefined)).toEqual(record);
    expect(store.find(token)).toEqual(record);
  });

  it("returns undefined when setting the plan of an unknown token", async () => {
    const store = await TokenStore.open(dir);
    expect(await store.setPlan("tok_missing", NOW)).toBeUndefined();
    expect(store.count()).toBe(0);
  });
});
