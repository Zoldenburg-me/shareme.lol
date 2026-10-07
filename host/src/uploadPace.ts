import { Transform, type Readable } from "node:stream";
import { HttpError } from "./http.js";

export interface PacedBody {
  /** The upload body, failing with a 408 once it falls below the minimum pace. */
  readonly body: Readable;
  /** Stop watching; call when the upload is done, whatever its outcome. */
  readonly stop: () => void;
}

/**
 * Pass `input` through, aborting it if a window of `windowMs` brings fewer than
 * `minBytesPerSecond` on average. An upload holds its quota reservation while it streams,
 * so a trickling client must not be able to keep that reservation for the whole request timeout.
 * Each window is judged on its own, so bytes sent early can't pay for a stall later.
 */
export function paceUpload(input: Readable, minBytesPerSecond: number, windowMs: number): PacedBody {
  const minBytes = Math.ceil((minBytesPerSecond * windowMs) / 1000);
  let windowBytes = 0;
  const body = new Transform({
    transform(chunk: Buffer, _enc, done) {
      windowBytes += chunk.length;
      done(null, chunk);
    },
  });
  const timer = setInterval(() => {
    if (windowBytes >= minBytes) {
      windowBytes = 0;
      return;
    }
    stop();
    input.unpipe(body);
    // connection: close, so the client can't keep the socket open by continuing to trickle.
    body.destroy(new HttpError(408, `Upload too slow (under ${minBytesPerSecond} bytes per second); try again on a faster connection`, { connection: "close" }));
  }, windowMs);
  const stop = () => clearInterval(timer);
  input.on("error", (err) => body.destroy(err));
  body.on("close", stop);
  input.pipe(body);
  return { body, stop };
}
