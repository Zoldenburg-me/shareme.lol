import type { FileHandle } from "node:fs/promises";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
// Carried between chunks so a secret split across a chunk boundary is still matched.
const OVERLAP_BYTES = 256;

const PATTERNS: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  ["private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["AWS secret access key", /aws_secret_access_key\s*[=:]/i],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["share-me token", /\bsm_[A-Za-z0-9_-]{43}\b/],
];

const match = (text: string) => PATTERNS.find(([, re]) => re.test(text))?.[0];

/** Scan a file for well-known credential formats. Returns the kind of the first match, if any. */
export async function findSecret(handle: FileHandle, size: number, chunkBytes = DEFAULT_CHUNK_BYTES): Promise<string | undefined> {
  const buffer = Buffer.alloc(chunkBytes);
  let carry = "";
  for (let position = 0; position < size; ) {
    const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    // latin1 maps bytes 1:1, so binary files cannot throw and offsets stay stable.
    const text = carry + buffer.toString("latin1", 0, bytesRead);
    const found = match(text);
    if (found) return found;
    carry = text.slice(-OVERLAP_BYTES);
  }
  return undefined;
}
