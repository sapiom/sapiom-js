/**
 * Cold-start deep-link target, read from the SPA's load URL.
 *
 * When the desktop app is opened by a `sapiom://agent/<id>` or
 * `sapiom://templates/<id>` link, the Electron host threads it onto the load URL
 * as `?agent=<id>` / `?template=<id>` (harness-desktop's boot.ts), so the very
 * first render already knows the target — no IPC race. Links that arrive while
 * the app is already running come through the desktop bridge instead
 * (`getDesktopBridge().onDeepLink`). A plain browser under `npx` simply never
 * carries the param, so this reads as "no target" there.
 */
import type { DeepLinkTarget } from "./desktop";

export function deepLinkFromSearch(
  search = typeof window === "undefined" ? "" : window.location.search,
): DeepLinkTarget | null {
  const params = new URLSearchParams(search);

  const definitionId = params.get("agent");
  if (definitionId) {
    const slug = params.get("agentSlug");
    return { kind: "agent", definitionId, ...(slug ? { slug } : {}) };
  }

  const templateId = params.get("template");
  if (templateId) {
    const slug = params.get("templateSlug");
    return { kind: "template", templateId, ...(slug ? { slug } : {}) };
  }

  return null;
}

/** The right pane's tabs, as persisted and as accepted on the URL. */
export const RIGHT_TABS = ["canvas", "steps", "code", "versions"] as const;
export type RightPaneTab = (typeof RIGHT_TABS)[number];

/**
 * Which right-pane tab to open, read from `?tab=`.
 *
 * The tab is React state persisted to local storage, so before this there was
 * no way to point someone at a particular pane — "open Studio, pick the agent,
 * then click Versions" instead of a link. It also makes the pane scriptable,
 * which is how the surface gets demonstrated and screenshotted at all.
 *
 * Validated against the known set rather than cast: an unknown value must fall
 * through to the stored preference, not wedge the pane on a tab that no longer
 * exists (the same failure the stored-value guard already handles for the
 * removed "skills" tab).
 */
export function tabFromSearch(
  search = typeof window === "undefined" ? "" : window.location.search,
): RightPaneTab | null {
  const raw = new URLSearchParams(search).get("tab");
  return RIGHT_TABS.includes(raw as RightPaneTab) ? (raw as RightPaneTab) : null;
}
