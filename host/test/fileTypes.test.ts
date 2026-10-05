import { describe, expect, it } from "vitest";
import { checkContent, extensionOf, FILE_TYPES, parseAllowedExtensions } from "../src/fileTypes.js";

const bytes = (...values: number[]) => Buffer.from(values);
const ascii = (s: string) => Buffer.from(s, "latin1");

describe("extensionOf", () => {
  it.each([
    ["Report.PDF", "pdf"],
    ["archive.tar.gz", "gz"],
    ["noext", undefined],
    [".env", undefined],
    ["trailing.", undefined],
  ])("%s → %s", (name, ext) => {
    expect(extensionOf(name)).toBe(ext);
  });
});

describe("parseAllowedExtensions", () => {
  it("defaults to every known type", () => {
    expect(parseAllowedExtensions(undefined)).toEqual(Object.keys(FILE_TYPES).sort());
  });

  it("accepts comma or space separated values with or without dots, case-insensitively", () => {
    expect(parseAllowedExtensions(".PDF, png  md")).toEqual(["md", "pdf", "png"]);
  });

  it("rejects extensions the host does not know how to serve", () => {
    expect(() => parseAllowedExtensions("pdf,exe")).toThrow(/exe/);
  });

  it("rejects an empty list", () => {
    expect(() => parseAllowedExtensions(" , ")).toThrow(/at least one/);
  });
});

describe("checkContent", () => {
  it.each([
    ["png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)],
    ["jpg", bytes(0xff, 0xd8, 0xff, 0xe0)],
    ["jpeg", bytes(0xff, 0xd8, 0xff, 0xdb)],
    ["gif", ascii("GIF89a....")],
    ["webp", ascii("RIFF\0\0\0\0WEBPVP8 ")],
    ["pdf", ascii("%PDF-1.7\n")],
    ["zip", ascii("PK\x03\x04rest")],
    ["docx", ascii("PK\x03\x04rest")],
    ["xlsx", ascii("PK\x03\x04rest")],
    ["pptx", ascii("PK\x03\x04rest")],
    ["mp4", ascii("\0\0\0\x18ftypisom")],
    ["webm", bytes(0x1a, 0x45, 0xdf, 0xa3, 1)],
    ["mp3", ascii("ID3\x04\0")],
    ["mp3", bytes(0xff, 0xfb, 0x90, 0x00)],
    ["wav", ascii("RIFF\0\0\0\0WAVEfmt ")],
    ["html", ascii("<!doctype html><p>hi</p>")],
    ["md", Buffer.from("# Résumé ✓", "utf8")],
    ["svg", ascii("<svg xmlns='http://www.w3.org/2000/svg'/>")],
    ["txt", Buffer.alloc(0)],
  ])("accepts genuine %s content", (ext, head) => {
    expect(checkContent(ext, head)).toBeUndefined();
  });

  it.each([
    ["png", ascii("not a png at all")],
    ["pdf", ascii("MZ\x90\0 windows exe")],
    ["zip", ascii("%PDF-1.4")],
    ["mp4", ascii("\0\0\0\x18moovisom")],
    ["webp", ascii("RIFF\0\0\0\0WAVEfmt ")],
    ["txt", bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00)],
    ["html", ascii("<html>\0\0\0binary")],
  ])("rejects %s whose bytes don't match", (ext, head) => {
    expect(checkContent(ext, head)).toMatch(new RegExp(`\\.${ext}`));
  });
});
