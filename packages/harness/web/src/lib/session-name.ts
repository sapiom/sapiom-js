/**
 * Session display names. A session is an ACTIVITY in a workspace, so the
 * server names it after the workspace folder when it is created — "acme-app",
 * then "acme-app 2" for the next one in that folder — and persists that name
 * on the record. The name is owned by the session, never recomputed from its
 * position among live siblings, so one session exiting or resuming cannot
 * relabel another.
 *
 * Precedence, most specific first:
 *   1. a user rename (double-click the rail label, or the header's ⋯ menu) —
 *      persisted client-side in ui-prefs because the server has no rename
 *      endpoint yet;
 *   2. the session's persisted title (the server default, or anything more
 *      specific the harness learned later);
 *   3. the folder basename, only for a record with no title at all.
 */
import type { HarnessSession } from "@shared/types";

import { basenameOf } from "./paths";

export type SessionNameOverrides = Record<string, string>;

export function sessionDisplayName(
  session: HarnessSession,
  overrides: SessionNameOverrides,
): string {
  const custom = overrides[session.id]?.trim();
  if (custom) return custom;
  return session.title || basenameOf(session.cwd);
}
