/**
 * Writes HARNESS_CONTEXT_FILE (`.sapiom/harness-context.json`) in a
 * session's cwd — the agent-legible mirror of that session's workflow
 * binding. Called on session create (`boundWorkflow: null`) and on every
 * `PATCH /api/sessions/:id/workflow`, so the file always exists once a
 * session has started; unbinding writes `boundWorkflow: null` rather than
 * deleting the file, so a concurrent read from the agent never race a
 * momentary ENOENT.
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
