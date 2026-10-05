import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFonts } from "../src/fonts.js";

describe("loadFonts", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-fonts-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads the woff2 files from the fonts folder next to the landing page", async () => {
    await mkdir(join(dir, "fonts"));
    await writeFile(join(dir, "fonts", "dm-sans.woff2"), "font");
    await writeFile(join(dir, "fonts", "README.md"), "not a font");
    const fonts = await loadFonts(dir);
    expect([...fonts.keys()]).toEqual(["dm-sans.woff2"]);
    expect(fonts.get("dm-sans.woff2")?.toString()).toBe("font");
  });

  it("serves no fonts when the folder is missing", async () => {
    expect((await loadFonts(dir)).size).toBe(0);
  });
});
