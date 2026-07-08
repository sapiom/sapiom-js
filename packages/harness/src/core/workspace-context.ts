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
 * sites are wired. Unbinding writes `boundWorkflow: null` rather than
 * deleting the file, so a concurrent read from the agent never races a
 * momentary ENOENT.
 */

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

  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `.harness-context.json.tmp-${process.pid}-${Date.now()}`);
    await fs.writeFile(tmpPath, JSON.stringify(context, null, 2) + "\n", "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    console.error(`[harness] failed to write ${filePath}:`, err);
  }
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
