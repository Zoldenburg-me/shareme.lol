import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStoredLogin, saveLogin, storedLoginPath } from "../src/login.js";

const POLICY = { allowedExtensions: ["md"], maxFileBytes: 10, maxTtlSeconds: 60 };

describe("stored login", () => {
  let home: string;
  let path: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "share-login-"));
    path = storedLoginPath(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("lives at ~/.config/share-me/config.json", () => {
    expect(path).toBe(join(home, ".config", "share-me", "config.json"));
  });

  it("returns undefined when nobody has logged in", () => {
    expect(readStoredLogin(path)).toBeUndefined();
  });

  it("saves only after the host accepts the token, with owner-only permissions", async () => {
    const verify = vi.fn().mockResolvedValue(POLICY);
    const login = { host: "https://share.example.com", token: "t".repeat(40) };

    expect(await saveLogin(login, path, verify)).toEqual(POLICY);

    expect(verify).toHaveBeenCalledWith(login);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(login);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect(readStoredLogin(path)).toEqual(login);
  });

  it("tightens permissions when overwriting an existing file", async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{}", { mode: 0o644 });
    await saveLogin({ host: "https://a.b", token: "x" }, path, vi.fn().mockResolvedValue(POLICY));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("writes nothing when the host rejects the token", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("Share host returned 401: Unauthorized"));
    await expect(saveLogin({ host: "https://a.b", token: "bad" }, path, verify)).rejects.toThrow(/401/);
    expect(readStoredLogin(path)).toBeUndefined();
  });

  it("explains how to recover from a damaged file", async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json");
    expect(() => readStoredLogin(path)).toThrow(/log in again/);
    await writeFile(path, JSON.stringify({ host: "https://a.b" }));
    expect(() => readStoredLogin(path)).toThrow(/log in again/);
  });
});
