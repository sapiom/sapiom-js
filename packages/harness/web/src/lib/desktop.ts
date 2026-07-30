/**
 * Desktop-app integration, from the SPA's side.
 *
 * This same bundle is served two ways: by `npx @sapiom/harness` into a plain
 * browser, and by the Electron app (`@sapiom/harness-desktop`) into its main
 * window. The desktop build injects a preload that exposes `window.sapiomDesktop`;
 * a browser has nothing. So **presence of the bridge is how we know where we are**,
 * and every desktop-only affordance must be feature-detected through here rather
 * than assumed — a browser user must never see a button that cannot work.
 *
 * The bridge type is DECLARED here rather than imported, on purpose: the
 * dependency runs the other way (the desktop app depends on this package, never
 * the reverse), so importing its types would be a cycle. That makes this a mirror
 * of `harness-desktop/src/main/ipc.ts`, which is the source of truth — if you
 * change the contract there, change it here. The runtime guard below is what keeps
 * a mismatch from becoming a crash: an older desktop build simply reads as
 * "no bridge".
 */

/** Result of an on-demand update check. Mirrors the desktop app's `UpdateCheckOutcome`. */
export type UpdateCheckOutcome =
  | { kind: "available"; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "up-to-date"; version: string; channel: string }
  | { kind: "disabled"; reason: string }
  | { kind: "failed"; message: string };

export interface DesktopBridge {
  /** The desktop app's own version (may be empty on older builds). */
  appVersion: string;
  checkForUpdates: () => Promise<UpdateCheckOutcome>;
  // No restart method: applying an update is confirmed by a native dialog in the
  // desktop app, so page code — which shares an origin with agent-authored files
  // the harness serves — has no way to end a user's sessions.
}

declare global {
  interface Window {
    sapiomDesktop?: unknown;
  }
}

/** Where the bridge is looked for. Injectable so this is testable in the
 *  Node-environment unit runner, which has no `window` at all. */
export interface DesktopHost {
  sapiomDesktop?: unknown;
}

/** The real host, or undefined outside a browser. */
function defaultHost(): DesktopHost | undefined {
  return typeof window === "undefined" ? undefined : window;
}

/**
 * The desktop bridge, or null when running in a browser.
 *
 * Validates the shape instead of trusting the flag. A desktop build older than a
 * given SPA build can expose a bridge without a newer method, and reading it would
 * throw inside a click handler — the kind of failure that surfaces as a dead
 * button. Anything unrecognised degrades to "browser", which is always safe.
 */
export function getDesktopBridge(host: DesktopHost | undefined = defaultHost()): DesktopBridge | null {
  const candidate = host?.sapiomDesktop;
  if (!candidate || typeof candidate !== "object") return null;
  const bridge = candidate as Partial<DesktopBridge>;
  if (typeof bridge.checkForUpdates !== "function") return null;
  return {
    appVersion: typeof bridge.appVersion === "string" ? bridge.appVersion : "",
    checkForUpdates: bridge.checkForUpdates,
  };
}

/** How the Settings popover should render a check result. */
export interface UpdateStatusView {
  text: string;
  /** `action` means the user must restart — the desktop app raises that prompt itself. */
  tone: "info" | "action" | "error";
}

/**
 * Turn an outcome into something worth reading.
 *
 * The wording lives on this side because only the UI knows its own context, and
 * because each state has a genuinely different next step: wait, restart, nothing,
 * or fix something. A single "checked!" message for all of them would be the same
 * as no message.
 */
export function describeUpdateOutcome(outcome: UpdateCheckOutcome): UpdateStatusView {
  switch (outcome.kind) {
    case "available":
      return { text: `Downloading ${outcome.version}…`, tone: "info" };
    case "downloaded":
      // Deliberately distinct from "available": it's on disk already, so the only
      // thing standing between the user and the new version is the restart.
      return { text: `${outcome.version} is ready to install.`, tone: "action" };
    case "up-to-date":
      return { text: `Up to date (${outcome.version}, ${outcome.channel}).`, tone: "info" };
    case "disabled":
      return { text: `Updates are off: ${outcome.reason}.`, tone: "error" };
    case "failed":
      return { text: `Couldn't check: ${outcome.message}`, tone: "error" };
  }
}
