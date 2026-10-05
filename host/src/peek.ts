import { Readable } from "node:stream";

export interface Peeked {
  /** Up to the requested number of leading bytes. */
  readonly head: Buffer;
  /** The full original stream, including the peeked bytes. */
  readonly body: Readable;
  /** Read and drop the rest of the input so the client can receive an error response. */
  readonly discard: () => void;
}

/** Read the first `bytes` of a stream without losing them. */
export async function peek(input: Readable, bytes: number): Promise<Peeked> {
  const it = input[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const chunks: Buffer[] = [];
  let total = 0;
  let ended = false;
  while (total < bytes) {
    const next = await it.next();
    if (next.done) {
      ended = true;
      break;
    }
    chunks.push(next.value);
    total += next.value.length;
  }
  const prefix = Buffer.concat(chunks);

  async function* replay(): AsyncGenerator<Buffer> {
    if (prefix.length > 0) yield prefix;
    if (ended) return;
    for (let next = await it.next(); !next.done; next = await it.next()) yield next.value;
  }

  const discard = () => {
    if (ended) return;
    void (async () => {
      for (let next = await it.next(); !next.done; next = await it.next());
    })().catch(() => undefined);
  };

  return { head: prefix.subarray(0, bytes), body: Readable.from(replay(), { objectMode: false }), discard };
}
