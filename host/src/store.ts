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

export const isValidId = (id: string): boolean => ID_PATTERN.test(id);

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
    return new FileStore(filesDir, new Map(metas.map((m) => [m.id, m])));
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
      };
      await writeFile(join(dir, `${META}.tmp`), JSON.stringify(meta));
      await rename(join(dir, `${META}.tmp`), join(dir, META));
      this.index = new Map([...this.index, [id, meta]]);
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

  openBlob(id: string): Readable {
    if (!isValidId(id)) throw new Error(`Invalid id: ${id}`);
    return createReadStream(join(this.filesDir, id, BLOB));
  }

  async delete(id: string): Promise<boolean> {
    if (!isValidId(id) || !this.index.has(id)) return false;
    this.index = new Map([...this.index].filter(([key]) => key !== id));
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
