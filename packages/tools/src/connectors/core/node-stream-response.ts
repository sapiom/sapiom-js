import { Readable } from "node:stream";

/**
 * Expose a fetch `Response`'s body as a Node `Readable`, matching gaxios' default node-fetch
 * transport. gaxios returns `res.body` verbatim for `responseType: "stream"`, and Google SDK media
 * downloads consume it with `res.data.pipe(...)` / `res.data.on(...)`. Our fetch layers use undici,
 * whose `.body` is a web `ReadableStream` (no `.pipe`) — so wrap the response to hand back a Node
 * Readable instead. Both the proxy authClient and the offline stub route through this so they can't
 * drift.
 *
 * Lazy + memoized: the Node Readable is created only when `.body` is read (the stream path), so the
 * JSON/text paths — which read via `res.json()` / `res.text()`, not `.body` — are untouched and the
 * underlying web stream is never double-consumed. Mutates and returns the same `Response`.
 */
export function withNodeStreamBody(res: Response): Response {
  const webBody = res.body;
  if (webBody) {
    let nodeBody: Readable | undefined;
    Object.defineProperty(res, "body", {
      configurable: true,
      get: () =>
        (nodeBody ??= (
          Readable as unknown as {
            fromWeb: (s: ReadableStream<Uint8Array>) => Readable;
          }
        ).fromWeb(webBody)),
    });
  }
  return res;
}
