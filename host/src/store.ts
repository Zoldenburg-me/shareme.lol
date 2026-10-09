import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface FileMeta {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Token id of the uploader; absent for files uploaded with the admin token. */
  readonly owner?: string;
  /** Code behind the /r/<code> short link; missing only if it could not be saved for an older file. */
  readonly shortCode?: string;
}

export interface CreateInput {
  readonly filename: string;
  readonly contentType: string;
  readonly ttlSeconds: number;
  readonly maxBytes: number;
  readonly body: Readable;
  readonly clock: () => number;
  readonly owner?: string;
}

export class FileTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`File exceeds the ${maxBytes}-byte limit`);
    this.name = "FileTooLargeError";
  }
}

const ID_BYTES = 16;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BLOB = "blob";
const META = "meta.json";

// Short codes are bearer secrets too: 10 letters or digits is ~60 bits, and misses are rate-limited.
const SHORT_CODE_LENGTH = 10;
const SHORT_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// Largest multiple of the alphabet size that fits in a byte; higher bytes are dropped to avoid bias.
const SHORT_CODE_BYTE_LIMIT = 256 - (256 % SHORT_CODE_ALPHABET.length);
const SHORT_CODE_PATTERN = /^[A-Za-z0-9]{10}$/;

export const isValidId = (id: string): boolean => ID_PATTERN.test(id);
export const isValidShortCode = (code: string): boolean => SHORT_CODE_PATTERN.test(code);

function randomShortCode(): string {
  let code = "";
  while (code.length < SHORT_CODE_LENGTH) {
    for (const byte of randomBytes(SHORT_CODE_LENGTH * 2)) {
      if (byte < SHORT_CODE_BYTE_LIMIT && code.length < SHORT_CODE_LENGTH) code += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length];
    }
  }
  return code;
}

const codeIndex = (metas: Iterable<FileMeta>): ReadonlyMap<string, string> =>
  new Map([...metas].flatMap((m) => (m.shortCode ? [[m.shortCode, m.id] as const] : [])));

function sizeLimiter(maxBytes: number): { stream: Transform; bytes: () => number } {
  let seen = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      done(seen > maxBytes ? new FileTooLargeError(maxBytes) : null, chunk);
    },
  });
  return { stream, bytes: () => seen };
}

/** Disk-backed store: <root>/files/<id>/{blob,meta.json}, with an in-memory index. */
export class FileStore {
  private constructor(
    private readonly filesDir: string,
    private index: ReadonlyMap<string, FileMeta>,
    private codes: ReadonlyMap<string, string> = codeIndex(index.values()),
  ) {}

  static async open(root: string): Promise<FileStore> {
    const filesDir = join(root, "files");
    await mkdir(filesDir, { recursive: true });
    const metas: FileMeta[] = [];
    // Sequential on purpose: avoids EMFILE on large volumes at startup.
    for (const id of (await readdir(filesDir)).filter(isValidId)) {
      const meta = await readMeta(filesDir, id);
      if (meta) metas.push(meta);
    }
    const store = new FileStore(filesDir, new Map(metas.map((m) => [m.id, m])));
    await store.backfillShortCodes();
    return store;
  }

  /** Gives files stored before short links existed a code, saved so it survives restarts. */
  private async backfillShortCodes(): Promise<void> {
    for (const meta of [...this.index.values()].filter((m) => !m.shortCode)) {
      const updated: FileMeta = { ...meta, shortCode: this.newShortCode(meta.id) };
      try {
        await this.writeMeta(updated);
      } catch (err) {
        this.releaseShortCode(updated.shortCode!);
        // Without a saved code the link would change on every restart; keep only the full link.
        console.error(`[share-host] could not add a short code to ${meta.id.slice(0, 4)}…:`, err);
        continue;
      }
      this.remember(updated);
    }
  }

  /** Draws an unused code and reserves it at once, so a concurrent upload can't draw the same one. */
  private newShortCode(id: string): string {
    for (;;) {
      const code = randomShortCode();
      if (this.codes.has(code)) continue;
      this.codes = new Map([...this.codes, [code, id]]);
      return code;
    }
  }

  private releaseShortCode(code: string): void {
    this.codes = new Map([...this.codes].filter(([key]) => key !== code));
  }

  private remember(meta: FileMeta): void {
    this.index = new Map([...this.index, [meta.id, meta]]);
    if (meta.shortCode) this.codes = new Map([...this.codes, [meta.shortCode, meta.id]]);
  }

  private async writeMeta(meta: FileMeta): Promise<void> {
    const dir = join(this.filesDir, meta.id);
    await writeFile(join(dir, `${META}.tmp`), JSON.stringify(meta));
    await rename(join(dir, `${META}.tmp`), join(dir, META));
  }

  async create(input: CreateInput): Promise<FileMeta> {
    const id = randomBytes(ID_BYTES).toString("base64url");
    const dir = join(this.filesDir, id);
    await mkdir(dir);
    try {
      const limiter = sizeLimiter(input.maxBytes);
      const tmp = join(dir, `${BLOB}.part`);
      await pipeline(input.body, limiter.stream, createWriteStream(tmp));
      await rename(tmp, join(dir, BLOB));
      const finishedAt = input.clock();
      const meta: FileMeta = {
        id,
        filename: input.filename,
        contentType: input.contentType,
        size: limiter.bytes(),
        createdAt: finishedAt,
        expiresAt: finishedAt + input.ttlSeconds * 1000,
        ...(input.owner ? { owner: input.owner } : {}),
        shortCode: this.newShortCode(id),
      };
      try {
        await this.writeMeta(meta);
      } catch (err) {
        this.releaseShortCode(meta.shortCode!);
        throw err;
      }
      this.remember(meta);
      return meta;
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  get(id: string, now: number): FileMeta | undefined {
    if (!isValidId(id)) return undefined;
    const meta = this.index.get(id);
    return meta && meta.expiresAt > now ? meta : undefined;
  }

  resolveShortCode(code: string, now: number): FileMeta | undefined {
    if (!isValidShortCode(code)) return undefined;
    const id = this.codes.get(code);
    return id ? this.get(id, now) : undefined;
  }

  /** Live files; only those of `owner` when one is given. */
  list(now: number, owner?: string): readonly FileMeta[] {
    return [...this.index.values()].filter((m) => m.expiresAt > now && (owner === undefined || m.owner === owner));
  }

  usedBytes(owner: string): number {
    return [...this.index.values()].filter((m) => m.owner === owner).reduce((sum, m) => sum + m.size, 0);
  }

  /** Files of `owner` still on disk, expired-but-unswept included (as in usedBytes). */
  fileCount(owner: string): number {
    return [...this.index.values()].filter((m) => m.owner === owner).length;
  }

  totalBytes(): number {
    return [...this.index.values()].reduce((sum, m) => sum + m.size, 0);
  }

  /** Move a live file's expiry; undefined if the file is gone or already expired at `now`. */
  async setExpiry(id: string, expiresAt: number, now: number): Promise<FileMeta | undefined> {
    const meta = this.get(id, now);
    if (!meta) return undefined;
    const updated: FileMeta = { ...meta, expiresAt };
    try {
      await this.writeMeta(updated);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    if (!this.index.has(id)) return undefined;
    this.remember(updated);
    return updated;
  }

  openBlob(id: string): Readable {
    if (!isValidId(id)) throw new Error(`Invalid id: ${id}`);
    return createReadStream(join(this.filesDir, id, BLOB));
  }

  async delete(id: string): Promise<boolean> {
    const meta = isValidId(id) ? this.index.get(id) : undefined;
    if (!meta) return false;
    this.index = new Map([...this.index].filter(([key]) => key !== id));
    if (meta.shortCode) this.releaseShortCode(meta.shortCode);
    await rm(join(this.filesDir, id), { recursive: true, force: true });
    return true;
  }

  /** Delete every file uploaded with one token (used when that token is revoked). */
  async deleteByOwner(owner: string): Promise<number> {
    const ids = [...this.index.values()].filter((m) => m.owner === owner).map((m) => m.id);
    for (const id of ids) await this.delete(id);
    return ids.length;
  }

  /** Delete files whose owner token is gone, e.g. after a crash between revoke and its cascade. */
  async deleteOrphans(isLiveOwner: (owner: string) => boolean): Promise<number> {
    const ids = [...this.index.values()].filter((m) => m.owner !== undefined && !isLiveOwner(m.owner)).map((m) => m.id);
    for (const id of ids) await this.delete(id);
    return ids.length;
  }

  async sweep(now: number): Promise<string[]> {
    const expired = [...this.index.values()].filter((m) => m.expiresAt <= now).map((m) => m.id);
    const removed: string[] = [];
    for (const id of expired) {
      try {
        await this.delete(id);
        removed.push(id);
      } catch (err) {
        console.error(`[share-host] failed to delete expired file ${id.slice(0, 4)}…:`, err);
      }
    }
    return removed;
  }
}

async function readMeta(filesDir: string, id: string): Promise<FileMeta | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(filesDir, id, META), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Upload never completed (no meta.json): remove the leftovers.
      await rm(join(filesDir, id), { recursive: true, force: true });
    } else {
      console.error(`[share-host] could not read metadata for ${id.slice(0, 4)}…, skipping:`, err);
    }
    return undefined;
  }
  try {
    return JSON.parse(raw) as FileMeta;
  } catch {
    console.error(`[share-host] corrupt metadata for ${id.slice(0, 4)}…, leaving on disk for inspection`);
    return undefined;
  }
}
