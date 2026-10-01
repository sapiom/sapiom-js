/**
 * Build a cache-busted `file://` URL for `import()`-ing a freshly bundled
 * file from disk.
 *
 * Both `check` and `local/load` bundle an agent to a temp file and then
 * dynamically `import()` it, appending `?t=<timestamp>` so re-running against
 * an unchanged path (e.g. `sapiom dev`'s watch loop) doesn't hit Node's ESM
 * module cache. The URL must be built with `pathToFileURL` rather than a raw
 * `file://${path}` template: `path.join`/`esbuild`'s output path use the
 * platform's own separator, so on Windows the raw template produces an
 * invalid URL (backslashes, and a missing leading `/` before a drive
 * letter). `pathToFileURL` percent-encodes the path and handles both
 * platforms correctly.
 */
import { pathToFileURL } from "node:url";

export function bundleFileUrl(bundlePath: string): string {
  const url = pathToFileURL(bundlePath);
  url.search = `t=${Date.now()}`;
  return url.href;
}
