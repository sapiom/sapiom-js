/**
 * Where a URL may open from the main window. Kept free of an `electron` import so
 * the rules are unit-tested (see vitest.config.ts); `windows.ts` applies them.
 *
 * "Local" is not "ours": agents run dev servers on other localhost ports, and only
 * the harness origin the main window loaded may keep its preload (SAP-4382).
 */

/** Where a navigation from the main window should land. */
export type NavigationTarget =
  /** The harness origin itself: stays in the main window. */
  | "harness"
  /** Another 127.0.0.1/localhost origin: the sandboxed preview window. */
  | "local"
  /** Anything else: the system browser (or nowhere, for a non-web scheme). */
  | "external";

/** An http(s) URL on 127.0.0.1 or localhost, any port. */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/** Classify `url` against the harness origin (`http://127.0.0.1:<port>`). */
export function classifyNavigation(url: string, harnessOrigin: string): NavigationTarget {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return "external";
  }
  if (origin === harnessOrigin) return "harness";
  return isLocalUrl(url) ? "local" : "external";
}
