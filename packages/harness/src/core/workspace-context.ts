/**
 * Writes HARNESS_CONTEXT_FILE (`.sapiom/harness-context.json`) in a
 * session's cwd — the agent-legible mirror of that session's workflow
 * binding. Called unconditionally from `SessionManager.create()`
 * (`boundWorkflow: null`) so the file exists for every session regardless of
 * entry point (REST, `autoCreateSession`), as a best-effort backfill from
 * `SessionManager.resume()` when it's missing entirely, and on every
 * `PATCH /api/sessions/:id/workflow`. Unbinding writes `boundWorkflow: null`
 * rather than deleting the file, so a concurrent read from the agent never
 * races a momentary ENOENT.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { HARNESS_CONTEXT_FILE, type HarnessWorkspaceContext, type WorkflowInfo } from "../shared/types.js";

function toContextWorkflow(workflow: WorkflowInfo | null): HarnessWorkspaceContext["boundWorkflow"] {
  if (!workflow) return null;
  return { name: workflow.name, path: workflow.path, definitionId: workflow.definitionId };
}

/**
 * Atomically writes `<cwd>/.sapiom/harness-context.json`. Best-effort: a
 * session's cwd could in principle be unwritable (permissions, deleted out
 * from under the session) — that must never fail the REST call that
 * triggered it, so errors are logged, not thrown.
 */
export async function writeHarnessContext(cwd: string, boundWorkflow: WorkflowInfo | null): Promise<void> {
  const filePath = path.join(cwd, HARNESS_CONTEXT_FILE);
  const context: HarnessWorkspaceContext = {
    boundWorkflow: toContextWorkflow(boundWorkflow),
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
 * binding this layer has no way to reconstruct (it only knows a workflow
 * *path*, not the full `WorkflowInfo` `writeHarnessContext` needs).
 */
export async function harnessContextFileExists(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, HARNESS_CONTEXT_FILE));
    return true;
  } catch {
    return false;
  }
}
