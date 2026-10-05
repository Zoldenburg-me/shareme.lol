import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export class PathNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathNotAllowedError";
  }
}

export interface ShareableFile {
  readonly path: string;
  readonly size: number;
  /** Open handle to the exact inode that passed the checks. The caller must close it. */
  readonly handle: FileHandle;
}

// Defense in depth: never share obvious credential files even if they sit in an allowed dir.
const SENSITIVE_DIRS = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".gcloud", ".kube", ".docker", ".git", ".config", ".password-store",
]);
const SENSITIVE_NAMES = [
  /^\.env(\..*)?$/i,
  /\.env$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|netrc|pypirc|pgpass|git-credentials|htpasswd)$/i,
  /^credentials(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /\.tfstate(\.backup)?$/i,
  /_history$/i,
];

const isSensitive = (segment: string) => SENSITIVE_DIRS.has(segment.toLowerCase()) || SENSITIVE_NAMES.some((re) => re.test(segment));

const isInside = (dir: string, target: string): boolean => {
  const rel = relative(dir, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

async function realpathOrThrow(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new PathNotAllowedError(`File does not exist: ${path}`);
  }
}

async function checkPath(input: string, allowedDirs: readonly string[]): Promise<string> {
  if (!isAbsolute(input)) throw new PathNotAllowedError(`Path must be absolute, got "${input}"`);
  const real = await realpathOrThrow(input);
  const roots = await Promise.all(allowedDirs.map((d) => realpath(d).catch(() => undefined)));
  const root = roots.find((r): r is string => r !== undefined && isInside(r, real));
  if (!root) {
    throw new PathNotAllowedError(`"${input}" is outside the allowed share directories: ${allowedDirs.join(", ")}`);
  }
  if (relative(root, real).split(sep).some(isSensitive)) {
    throw new PathNotAllowedError(`Refusing to share "${input}": it looks like a sensitive/credential file`);
  }
  return real;
}

async function verifyHandle(input: string, real: string, handle: FileHandle): Promise<number> {
  const info = await handle.stat();
  if (!info.isFile()) throw new PathNotAllowedError(`"${input}" is not a regular file`);
  if (info.nlink > 1) {
    throw new PathNotAllowedError(`Refusing to share "${input}": it is a hard link, which could alias a file outside the allowed dirs`);
  }
  // Re-resolve after opening: if any path component was swapped (e.g. for a symlink) between
  // the check and the open, the opened inode will not match what the path now points to.
  const now = await stat(await realpathOrThrow(input));
  if ((await realpath(input)) !== real || now.dev !== info.dev || now.ino !== info.ino) {
    throw new PathNotAllowedError(`"${input}" changed while it was being checked; refusing to share it`);
  }
  return info.size;
}

/** Validate `input` against the allowlist and open it, returning a handle to the verified file. */
export async function openShareableFile(input: string, allowedDirs: readonly string[]): Promise<ShareableFile> {
  const real = await checkPath(input, allowedDirs);
  let handle: FileHandle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EISDIR") throw new PathNotAllowedError(`"${input}" is not a regular file`);
    throw new PathNotAllowedError(`Could not open "${input}" (${code ?? "unknown error"})`);
  }
  try {
    return { path: real, size: await verifyHandle(input, real, handle), handle };
  } catch (err) {
    await handle.close();
    throw err;
  }
}
