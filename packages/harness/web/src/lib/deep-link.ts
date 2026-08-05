/**
 * Cold-start deep-link target, read from the SPA's load URL.
 *
 * When the desktop app is opened by a `sapiom://agent/<id>` link, the Electron
 * host threads that id onto the load URL as `?agent=<id>` (harness-desktop's
 * boot.ts), so the very first render already knows the target — no IPC race.
 * Links that arrive while the app is already running come through the desktop
 * bridge instead (`getDesktopBridge().onDeepLink`). A plain browser under `npx`
 * simply never carries the param, so this reads as "no target" there.
 */
export interface DeepLinkAgentTarget {
  definitionId: string;
  slug?: string;
}

export function agentFromSearch(
  search = typeof window === "undefined" ? "" : window.location.search,
): DeepLinkAgentTarget | null {
  const params = new URLSearchParams(search);
  const definitionId = params.get("agent");
  if (!definitionId) return null;
  const slug = params.get("agentSlug");
  return slug ? { definitionId, slug } : { definitionId };
}
