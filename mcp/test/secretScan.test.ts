import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSecret } from "../src/secretScan.js";

// Fixtures are assembled at runtime so no literal key or token shapes live in the repo
// (keeps leak scanners and push protection from flagging this test file).
const concat = (...parts: string[]) => parts.join("");
const pemHeader = (kind = "") => concat("-----BEGIN ", kind, "PRIVATE ", "KEY-----");

describe("findSecret", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-scan-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const scan = async (content: string | Buffer, chunkSize?: number) => {
    const path = join(dir, "f");
    await writeFile(path, content);
    const handle = await open(path, "r");
    try {
      return await findSecret(handle, Buffer.byteLength(content), chunkSize);
    } finally {
      await handle.close();
    }
  };

  it.each([
    [`${pemHeader("OPENSSH ")}\nabc`, "private key"],
    [pemHeader("RSA "), "private key"],
    [`key = ${concat("AK", "IA", "Q".repeat(16))}`, "AWS access key id"],
    ["aws_secret_access_key = abc", "AWS secret access key"],
    [`token: ${concat("gh", "p_", "a".repeat(36))}`, "GitHub token"],
    [`ANTHROPIC_API_KEY=${concat("sk-", "ant-", "api03-", "b".repeat(40))}`, "Anthropic API key"],
    [concat("sk-", "proj-", "c".repeat(48)), "OpenAI API key"],
    [concat("xo", "xb-", "1234567890-abcdefghij"), "Slack token"],
    [concat("AI", "za", "d".repeat(35)), "Google API key"],
  ])("detects %s", async (content, kind) => {
    expect(await scan(`some report text\n${content}\nmore`)).toBe(kind);
  });

  it("returns undefined for ordinary content", async () => {
    expect(await scan("# Quarterly report\nRevenue grew 12%.\n<script>alert(1)</script>")).toBeUndefined();
  });

  it("finds secrets that straddle a chunk boundary", async () => {
    const content = `${"x".repeat(1000)}${pemHeader()}${"y".repeat(1000)}`;
    expect(await scan(content, 1010)).toBe("private key");
  });
});
