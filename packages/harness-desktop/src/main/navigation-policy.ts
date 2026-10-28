/**
 * Only the harness origin the main window loaded may keep its preload: agents run dev servers on
 * other localhost ports (SAP-4382). No `electron` import, so the rules are unit-tested.
 */

export type NavigationTarget = "harness" | "local" | "external";

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
