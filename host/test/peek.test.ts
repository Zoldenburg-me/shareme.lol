import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { peek } from "../src/peek.js";

const collect = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString();
};

const chunked = (...parts: string[]) => Readable.from(parts.map((p) => Buffer.from(p)), { objectMode: false });

describe("peek", () => {
  it("returns the head and replays the whole stream, including bytes past the head", async () => {
    const { head, body } = await peek(chunked("abc", "def", "ghi"), 4);
    expect(head.toString()).toBe("abcd");
    expect(await collect(body)).toBe("abcdefghi");
  });

  it("handles streams shorter than the requested head", async () => {
    const { head, body } = await peek(chunked("ab"), 10);
    expect(head.toString()).toBe("ab");
    expect(await collect(body)).toBe("ab");
  });

  it("handles empty streams", async () => {
    const { head, body } = await peek(chunked(), 10);
    expect(head.length).toBe(0);
    expect(await collect(body)).toBe("");
  });

  it("discard consumes the rest of the input", async () => {
    let pulled = 0;
    const source = new Readable({
      read() {
        pulled += 1;
        this.push(pulled <= 5 ? Buffer.from("xxxx") : null);
      },
    });
    const { discard } = await peek(source, 2);
    discard();
    await new Promise((resolve) => source.once("end", resolve));
    expect(pulled).toBe(6);
  });

  it("discard is a no-op when the input already ended", async () => {
    const { discard } = await peek(chunked("ab"), 10);
    expect(() => discard()).not.toThrow();
  });
});
