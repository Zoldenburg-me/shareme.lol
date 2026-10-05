import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const FONT_FILE = /^[a-z0-9-]+\.woff2$/;

/** Fonts are served from this host so pages make no requests to Google; they are small, so keep them in memory. */
export async function loadFonts(siteDir: string): Promise<ReadonlyMap<string, Buffer>> {
  const dir = join(siteDir, "fonts");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => FONT_FILE.test(name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return new Map();
  }
  const files = await Promise.all(names.map(async (name) => [name, await readFile(join(dir, name))] as const));
  return new Map(files);
}
