import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FALLBACK_LANDING, loadLandingPage, wrapPage } from "../src/landing.js";

describe("wrapPage", () => {
  it("wraps a page fragment in a full HTML document", () => {
    const html = wrapPage("<title>share-me</title><p>hi</p>");
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>share-me</title><p>hi</p>");
  });

  it("leaves a complete document untouched", () => {
    const doc = "<!DOCTYPE html><html><body>x</body></html>";
    expect(wrapPage(doc)).toBe(doc);
  });
});

describe("loadLandingPage", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "share-landing-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads and wraps the landing page file", async () => {
    await writeFile(join(dir, "index.html"), "<title>share-me</title>");
    expect(await loadLandingPage(join(dir, "index.html"), "https://share.acme.dev")).toContain("<title>share-me</title>");
  });

  it("replaces the canonical shareme.lol host with this host's public URL", async () => {
    await writeFile(join(dir, "index.html"), "<code>Set up share-me from https://shareme.lol/setup</code> shareme.lol");
    const html = await loadLandingPage(join(dir, "index.html"), "https://share.acme.dev");
    expect(html).toContain("Set up share-me from https://share.acme.dev/setup");
    expect(html).not.toContain("shareme.lol");
  });

  it("falls back to a status page when the file is missing", async () => {
    expect(await loadLandingPage(join(dir, "missing.html"), "https://share.acme.dev")).toBe(FALLBACK_LANDING);
    expect(FALLBACK_LANDING).toContain("share-me host is running");
  });
});
