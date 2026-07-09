/**
 * Writes HARNESS_CONTEXT_FILE (`.sapiom/harness-context.json`) in a
 * session's cwd — the agent-legible mirror of this workspace's UI state:
 * which workflow (if any) the session is bound to, every workflow the
 * registry currently knows about, and the session's own identity. Called
 * unconditionally from `SessionManager.create()` so the file exists for
 * every session regardless of entry point (REST, `autoCreateSession`), as a
 * backfill from `SessionManager.resume()` when it's missing entirely, on
 * every `PATCH /api/sessions/:id/workflow`, and whenever the workflow
 * registry changes (scan/connect) — see server/index.ts's
 * `writeSessionContext`/`scanWorkflowsAndBroadcast` for how those call
 * sites are wired, and both of which can legitimately fire concurrent
 * writes to the *same* destination (a scan's rewrite-all-open-sessions step
 * racing a user's live bind click, for instance) — see `withPerPathQueue`.
 * Unbinding writes `boundWorkflow: null` rather than deleting the file, so a
 * concurrent read from the agent never races a momentary ENOENT.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  HARNESS_CONTEXT_FILE,
  type HarnessKind,
  type HarnessWorkspaceContext,
  type HarnessWorkspaceContextWorkflow,
  type WorkflowInfo,
} from "../shared/types.js";

function toContextWorkflowEntry(workflow: WorkflowInfo): HarnessWorkspaceContextWorkflow {
  return { name: workflow.name, path: workflow.path, definitionId: workflow.definitionId };
}

export interface WorkspaceContextSession {
  id: string;
  cwd: string;
  harness: HarnessKind;
}

/**
 * Serializes writes per destination path. Two independent triggers can
 * legitimately race on the same `harness-context.json` (a workflow scan's
 * rewrite-all-open-sessions step, a bind/unbind, a fresh session's initial
 * write) — without this, concurrent writers could both compute the same
 * `Date.now()`-based tmp filename (confirmed via repro: a tight burst of
 * concurrent writes to one destination reliably collides within the same
 * millisecond) and steal each other's tmp file out from under a pending
 * `rename`, which fails with ENOENT. Serializing per path also fixes a
 * subtler issue beyond the crash: without it, whichever concurrent write's
 * disk I/O happens to finish first wins, which can silently apply writes
 * out of the order they were actually triggered in. Keyed by absolute
 * path; an entry is removed once nothing else has chained onto it, so this
 * never grows unbounded over a long-running server's lifetime.
 */
const writeQueues = new Map<string, Promise<void>>();

async function withPerPathQueue(filePath: string, task: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  // `task` never throws (its own try/catch logs and swallows) — chaining
  // onto both branches of `previous` is defense in depth, so one write's
  // failure can never wedge the queue for the next one to this same path.
  const current = previous.then(task, task);
  writeQueues.set(filePath, current);
  try {
    await current;
  } finally {
    if (writeQueues.get(filePath) === current) writeQueues.delete(filePath);
  }
}

/**
 * Atomically writes `<session.cwd>/.sapiom/harness-context.json`.
 * Best-effort: a session's cwd could in principle be unwritable
 * (permissions, deleted out from under the session) — that must never fail
 * the caller that triggered it, so errors are logged, not thrown.
 *
 * `workflows` is sorted by path before writing (deterministic, independent
 * of registry scan/insertion order) so an agent re-reading the file across
 * turns can diff it cheaply instead of re-parsing a reordered blob every
 * time.
 */
export async function writeHarnessContext(
  session: WorkspaceContextSession,
  boundWorkflow: WorkflowInfo | null,
  workflows: WorkflowInfo[],
): Promise<void> {
  const filePath = path.join(session.cwd, HARNESS_CONTEXT_FILE);
  const sortedWorkflows = [...workflows].sort((a, b) => a.path.localeCompare(b.path)).map(toContextWorkflowEntry);
  const context: HarnessWorkspaceContext = {
    boundWorkflow: boundWorkflow ? toContextWorkflowEntry(boundWorkflow) : null,
    workflows: sortedWorkflows,
    session: { id: session.id, cwd: session.cwd, harness: session.harness },
    updatedAt: new Date().toISOString(),
  };

  await withPerPathQueue(filePath, async () => {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      // A random suffix, not just pid+Date.now(): millisecond resolution is
      // not fine enough to stay unique across a burst of concurrent writes
      // to the same destination (confirmed via repro). Collision-proof
      // regardless of timing, independent of the queue above.
      const tmpPath = path.join(dir, `.harness-context.json.tmp-${process.pid}-${crypto.randomUUID()}`);
      await fs.writeFile(tmpPath, JSON.stringify(context, null, 2) + "\n", "utf8");
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      console.error(`[harness] failed to write ${filePath}:`, err);
    }
  });
}

/**
 * True if `<cwd>/.sapiom/harness-context.json` already exists. Used by
 * `SessionManager.resume()` to decide whether a backfill write is needed —
 * resume must never clobber a file that could already reflect a real
 * binding.
 */
export async function harnessContextFileExists(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, HARNESS_CONTEXT_FILE));
    return true;
  } catch {
    return false;
  }
}
