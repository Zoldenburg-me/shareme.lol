/** Bytes of the upload inspected to verify the content matches its extension. */
export const HEAD_BYTES = 512;

type Signature = (head: Buffer) => boolean;

interface FileType {
  readonly contentType: string;
  /** Binary formats: magic-number check. Text formats (no signature): must not contain NUL bytes. */
  readonly signature?: Signature;
}

const startsWith = (prefix: string): Signature => (head) => head.subarray(0, prefix.length).equals(Buffer.from(prefix, "latin1"));
const at = (offset: number, value: string): Signature => (head) =>
  head.subarray(offset, offset + value.length).equals(Buffer.from(value, "latin1"));
const both = (a: Signature, b: Signature): Signature => (head) => a(head) && b(head);
const either = (a: Signature, b: Signature): Signature => (head) => a(head) || b(head);

const ZIP = either(startsWith("PK\x03\x04"), startsWith("PK\x05\x06"));
const MP3_FRAME: Signature = (head) => head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
const text = (type: string): FileType => ({ contentType: `${type}; charset=utf-8` });

/** Every type the host knows how to serve safely. ALLOWED_EXTENSIONS may narrow this, never widen it. */
export const FILE_TYPES: Readonly<Record<string, FileType>> = {
  // Documents & text
  pdf: { contentType: "application/pdf", signature: startsWith("%PDF-") },
  html: text("text/html"),
  htm: text("text/html"),
  md: text("text/markdown"),
  txt: text("text/plain"),
  log: text("text/plain"),
  csv: text("text/csv"),
  json: { contentType: "application/json" },
  xml: { contentType: "application/xml" },
  // Office (OOXML containers are zip files)
  docx: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", signature: ZIP },
  xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", signature: ZIP },
  pptx: { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", signature: ZIP },
  zip: { contentType: "application/zip", signature: ZIP },
  // Images
  png: { contentType: "image/png", signature: startsWith("\x89PNG\r\n\x1a\n") },
  jpg: { contentType: "image/jpeg", signature: startsWith("\xff\xd8\xff") },
  jpeg: { contentType: "image/jpeg", signature: startsWith("\xff\xd8\xff") },
  gif: { contentType: "image/gif", signature: either(startsWith("GIF87a"), startsWith("GIF89a")) },
  webp: { contentType: "image/webp", signature: both(startsWith("RIFF"), at(8, "WEBP")) },
  svg: { contentType: "image/svg+xml" },
  // Audio & video
  mp4: { contentType: "video/mp4", signature: at(4, "ftyp") },
  webm: { contentType: "video/webm", signature: startsWith("\x1a\x45\xdf\xa3") },
  mp3: { contentType: "audio/mpeg", signature: either(startsWith("ID3"), MP3_FRAME) },
  wav: { contentType: "audio/wav", signature: both(startsWith("RIFF"), at(8, "WAVE")) },
};

const KNOWN = new Set(Object.keys(FILE_TYPES));

/** Lower-cased extension without the dot, or undefined for dotfiles and names without one. */
export function extensionOf(filename: string): string | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return undefined;
  return filename.slice(dot + 1).toLowerCase();
}

export function parseAllowedExtensions(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [...KNOWN].sort();
  const exts = [...new Set(raw.split(/[\s,]+/).map((e) => e.replace(/^\./, "").toLowerCase()).filter(Boolean))];
  if (exts.length === 0) throw new Error("ALLOWED_EXTENSIONS must list at least one extension");
  const unknown = exts.filter((e) => !KNOWN.has(e));
  if (unknown.length > 0) {
    throw new Error(
      `ALLOWED_EXTENSIONS contains types the host cannot serve safely: ${unknown.join(", ")}. Known: ${[...KNOWN].sort().join(", ")}`,
    );
  }
  return exts.sort();
}

export const contentTypeOf = (ext: string): string => FILE_TYPES[ext].contentType;

/** Returns a reason the bytes don't match the extension, or undefined when they do. */
export function checkContent(ext: string, head: Buffer): string | undefined {
  const type = FILE_TYPES[ext];
  if (!type) return `.${ext} is not a known file type`;
  if (head.length === 0) return undefined;
  const matches = type.signature ? type.signature(head) : !head.includes(0);
  return matches ? undefined : `File content does not look like a .${ext} file`;
}
