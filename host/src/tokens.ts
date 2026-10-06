import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A self-service access token. Only the SHA-256 hash of the token is ever stored. */
export interface TokenRecord {
  readonly id: string;
  readonly hash: string;
  readonly createdAt: number;
}

const TOKEN_PREFIX = "sm_";
const TOKEN_BYTES = 32;
const ID_PREFIX = "tok_";
const ID_BYTES = 6;
const FILE = "tokens.json";

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Disk-backed token registry (<dataDir>/tokens.json, mode 600), keyed by token hash. */
export class TokenStore {
  // Writes are chained so concurrent signups never overwrite each other.
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private records: ReadonlyMap<string, TokenRecord>,
  ) {}

  static async open(dataDir: string): Promise<TokenStore> {
    const path = join(dataDir, FILE);
    let list: TokenRecord[] = [];
    try {
      list = (JSON.parse(await readFile(path, "utf8")) as { tokens?: TokenRecord[] }).tokens ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return new TokenStore(path, new Map(list.map((r) => [r.hash, r])));
  }

  find(token: string): TokenRecord | undefined {
    return this.records.get(hashToken(token));
  }

  count(): number {
    return this.records.size;
  }

  async issue(now: number): Promise<{ token: string; record: TokenRecord }> {
    const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
    const record: TokenRecord = { id: ID_PREFIX + randomBytes(ID_BYTES).toString("base64url"), hash: hashToken(token), createdAt: now };
    await this.mutate((current) => new Map([...current, [record.hash, record]]));
    return { token, record };
  }

  async revoke(id: string): Promise<boolean> {
    let removed = false;
    await this.mutate((current) => {
      const next = new Map([...current].filter(([, r]) => r.id !== id));
      removed = next.size < current.size;
      return next;
    });
    return removed;
  }

  private mutate(change: (current: ReadonlyMap<string, TokenRecord>) => ReadonlyMap<string, TokenRecord>): Promise<void> {
    const run = this.queue.then(async () => {
      const next = change(this.records);
      if (next === this.records) return;
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify({ tokens: [...next.values()] }), { mode: 0o600 });
      await rename(tmp, this.path);
      this.records = next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
