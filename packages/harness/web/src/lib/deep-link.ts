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
