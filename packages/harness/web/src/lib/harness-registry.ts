/**
 * ONE reading of the adapter registry (GET /api/harnesses) for both provider
 * pickers: the composer's dropdown and the new-session dialog. Order,
 * selectability, and the honest unavailable-reason copy live here so the two
 * surfaces can never drift apart.
 */
import type { HarnessEntry, HarnessKind } from "@shared/types";
import { SPAWNABLE_HARNESS_KINDS } from "@shared/types";

/** Fallback shown until (or in case) the registry fetch resolves — the two
 *  embedded adapters every install ships, assumed selectable so demo mode
 *  and older servers behave exactly as before. Labels mirror the upstream
 *  adapter descriptors. `imageInput: false` is the honest pre-fetch default
 *  (no image affordance until the real registry confirms support). */
export const FALLBACK_HARNESSES: HarnessEntry[] = [
  { id: "claude-code", label: "Claude Code", mode: "embedded", experimental: false, installed: true, installMcpPrompt: "", imageInput: false },
  { id: "codex", label: "Codex CLI", mode: "embedded", experimental: false, installed: true, installMcpPrompt: "", imageInput: false },
];

/**
 * Menu order IS the registry order (upstream HARNESS_ADAPTER_INFOS leads with
 * claude-code). As of harness 0.1.4 the registry ships NO Sapiom-native
 * adapter (verified against origin/main registry.ts on 2026-07-20), so there
 * is nothing to hoist today and inventing a "Sapiom" ADAPTER row would be a
 * lie. (The composer's provider menu does lead with a "Sapiom Harness" row,
 * but that names the native CHAT pipeline — a mode, not a registry adapter —
 * see ComposerProvider.) The id check below is server-gated: the moment a
 * registry ships a `sapiom` adapter it leads the menu without a client
 * release.
 */
export function orderHarnesses(entries: HarnessEntry[]): HarnessEntry[] {
  const lead = entries.filter((entry) => entry.id === "sapiom");
  if (lead.length === 0) return entries;
  return [...lead, ...entries.filter((entry) => entry.id !== "sapiom")];
}

/** Only embedded, installed adapters with a full runtime contract can be
 *  spawned — everything else renders disabled with the reason in a tooltip. */
export function isHarnessSelectable(entry: HarnessEntry): boolean {
  return (
    entry.mode === "embedded" &&
    entry.installed &&
    (SPAWNABLE_HARNESS_KINDS as readonly string[]).includes(entry.id)
  );
}

/** Why a row is disabled, as tooltip copy. Honest about the actual state:
 *  external adapters live in their own app; a missing binary surfaces the
 *  server's own setup prompt (installMcpPrompt) when it ships one, and names
 *  the absence when it doesn't. */
export function harnessUnavailableReason(entry: HarnessEntry): string | null {
  if (isHarnessSelectable(entry)) return null;
  if (entry.mode === "external") return `${entry.label} runs in its own app. Studio can't launch it yet.`;
  if (!entry.installed) {
    const prompt = entry.installMcpPrompt.trim();
    return prompt.length > 0
      ? prompt
      : `${entry.label} isn't on this machine's PATH. Install its CLI, then restart the Studio server.`;
  }
  return `This Studio build can't launch ${entry.label} yet.`;
}

/** The label the registry ships for an id, falling back to the id itself. */
export function harnessLabel(entries: HarnessEntry[], id: HarnessKind | string): string {
  return entries.find((entry) => entry.id === id)?.label ?? id;
}
