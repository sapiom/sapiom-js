/**
 * Session display names, from first principles: a session is an ACTIVITY in
 * a workspace, so its default name is the workspace folder's basename — a
 * row reading "Claude Code" names a model, not a session. When several
 * sessions in one folder would share the default, later ones count up
 * ("scratch 2"); the agent kind shows only as the brand icon + tooltip.
 *
 * Precedence, most specific first:
 *   1. a user rename (double-click the rail label, or the header's ⋯ menu) —
 *      persisted client-side in ui-prefs because the server has no rename
 *      endpoint yet;
 *   2. the session's transcript-derived title (its own first
 *      prompt/ai-title) — the harness only sets `title` away from the
 *      folder basename when it learned something more specific;
 *   3. the folder basename, deduped among sessions still on the default.
 */
import type { HarnessSession } from "@shared/types";

export type SessionNameOverrides = Record<string, string>;

const basenameOf = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/** True when the session has nothing better than the folder default (the
 *  adapter initializes `title` to the cwd basename until a transcript title
 *  lands). */
function usesDefaultName(session: HarnessSession, overrides: SessionNameOverrides): boolean {
  if (overrides[session.id]?.trim()) return false;
  return !session.title || session.title === basenameOf(session.cwd);
}

export function sessionDisplayName(
  session: HarnessSession,
  allSessions: HarnessSession[],
  overrides: SessionNameOverrides,
): string {
  const custom = overrides[session.id]?.trim();
  if (custom) return custom;
  if (!usesDefaultName(session, overrides)) return session.title;
  const base = basenameOf(session.cwd);
  // Count up ONLY among same-folder LIVE sessions that are also on the
  // default — a sibling with a real title doesn't push this one to
  // "folder 2", and an exited session doesn't reserve the name from the
  // history shelf (the one live session in a folder is just the folder).
  const defaultSiblings = allSessions
    .filter(
      (s) =>
        s.cwd === session.cwd &&
        (s.status !== "exited" || s.id === session.id) &&
        usesDefaultName(s, overrides),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const index = defaultSiblings.findIndex((s) => s.id === session.id);
  return index > 0 ? `${base} ${index + 1}` : base;
}
