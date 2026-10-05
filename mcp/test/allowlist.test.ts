import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShareableFile, PathNotAllowedError } from "../src/allowlist.js";

describe("openShareableFile", () => {
  let root: string;
  let allowed: string;
  let outside: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "share-allow-")));
    allowed = join(root, "allowed");
    outside = join(root, "outside");
    await mkdir(join(allowed, "nested"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(allowed, "nested", "report.html"), "<h1>hi</h1>");
    await writeFile(join(outside, "secret.txt"), "nope");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("opens a file inside an allowed dir and reads the checked contents", async () => {
    const file = await openShareableFile(join(allowed, "nested", "report.html"), [allowed]);
    try {
      expect(file.path).toBe(join(allowed, "nested", "report.html"));
      expect(file.size).toBe(11);
      expect((await file.handle.readFile()).toString()).toBe("<h1>hi</h1>");
    } finally {
      await file.handle.close();
    }
  });

  it("rejects files outside the allowed dirs, including via ..", async () => {
    await expect(openShareableFile(join(outside, "secret.txt"), [allowed])).rejects.toBeInstanceOf(PathNotAllowedError);
    await expect(openShareableFile(join(allowed, "..", "outside", "secret.txt"), [allowed])).rejects.toThrow(/outside/);
  });

  it("rejects symlinks that escape the allowed dir", async () => {
    await symlink(join(outside, "secret.txt"), join(allowed, "link.txt"));
    await expect(openShareableFile(join(allowed, "link.txt"), [allowed])).rejects.toThrow(/outside/);
  });

  it("rejects hardlinks, which could alias a file from anywhere on the disk", async () => {
    await link(join(outside, "secret.txt"), join(allowed, "innocent.txt"));
    await expect(openShareableFile(join(allowed, "innocent.txt"), [allowed])).rejects.toThrow(/hard link/);
  });

  it("does not treat a sibling dir with a shared prefix as allowed", async () => {
    const sibling = `${allowed}-evil`;
    await mkdir(sibling);
    await writeFile(join(sibling, "x.txt"), "x");
    await expect(openShareableFile(join(sibling, "x.txt"), [allowed])).rejects.toThrow(/outside/);
  });

  it("rejects relative paths, directories and missing files", async () => {
    await expect(openShareableFile("nested/report.html", [allowed])).rejects.toThrow(/absolute/);
    await expect(openShareableFile(join(allowed, "nested"), [allowed])).rejects.toThrow(/regular file/);
    await expect(openShareableFile(join(allowed, "missing.txt"), [allowed])).rejects.toThrow(/does not exist/);
  });

  it.each([
    ".env", ".env.local", "prod.env", "id_rsa", "id_ed25519.pub", "server.pem", "tls.key", "cert.p12", "vault.kdbx",
    "terraform.tfstate", ".pgpass", ".git-credentials", ".pypirc", ".htpasswd", "credentials", "credentials.json",
    ".zsh_history", ".ssh/config", ".git/config", ".aws/credentials", ".config/gh/hosts.yml", ".gcloud/x.json",
  ])("refuses secret-looking path %s even inside an allowed dir", async (rel) => {
    const target = join(allowed, rel);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "secret");
    await expect(openShareableFile(target, [allowed])).rejects.toThrow(/sensitive/);
  });
});
