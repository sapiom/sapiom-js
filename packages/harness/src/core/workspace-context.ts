/**
 * Writes HARNESS_CONTEXT_FILE (`.sapiom/harness-context.json`) in a
 * session's cwd — the coding-agent-legible mirror of this workspace's UI
 * state: which agent (if any) the session is bound to, every agent the
 * registry currently knows about, and the session's own identity. Called
 * strictly from `SessionManager.create()` so the file exists for every
 * session regardless of entry point (REST, `autoCreateSession`), through
 * schema-aware preparation from `SessionManager.resume()`, on
 * every `PATCH /api/sessions/:id/workflow`, and whenever the workflow
 * registry changes (scan/connect) — see server/index.ts's
 * `writeSessionContext`/`scanWorkflowsAndBroadcast` for how those call
 * sites are wired, and both of which can legitimately fire concurrent
 * writes to the *same* destination (a scan's rewrite-all-open-sessions step
 * racing a user's live bind click, for instance) — see `withPerPathQueue`.
 * Unbinding writes `boundAgent: null` rather than deleting the file, so a
 * concurrent read from the coding agent never races a momentary ENOENT.
 */

import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  HARNESS_CONTEXT_FILE,
  SPAWNABLE_HARNESS_KINDS,
  type HarnessKind,
  type HarnessWorkspaceContext,
  type HarnessWorkspaceContextAgent,
  type WorkflowInfo,
} from "../shared/types.js";

function toContextAgentEntry(
  workflow: WorkflowInfo,
): HarnessWorkspaceContextAgent {
  return {
    name: workflow.name,
    path: workflow.path,
    definitionId: workflow.definitionId,
  };
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

async function withPerPathQueue(
  filePath: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  // Chain onto both branches of `previous`: strict launch/resume operations
  // may throw when they cannot make the prompt-visible schema safe, but that
  // must never wedge the queue for the next operation on this same path.
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
 * `agents` is sorted by path before writing (deterministic, independent
 * of registry scan/insertion order) so a coding agent re-reading the file
 * across turns can diff it cheaply instead of re-parsing a reordered blob
 * every time.
 */
export async function writeHarnessContext(
  session: WorkspaceContextSession,
  boundWorkflow: WorkflowInfo | null,
  workflows: WorkflowInfo[],
  isCurrent?: () => boolean,
): Promise<void> {
  try {
    await writeHarnessContextForLaunch(
      session,
      boundWorkflow,
      workflows,
      isCurrent,
    );
  } catch (err) {
    const filePath = path.join(session.cwd, HARNESS_CONTEXT_FILE);
    console.error(`[harness] failed to write ${filePath}:`, err);
  }
}

/**
 * The strict form used in SessionManager.create()'s pre-spawn window. A write
 * failure rejects creation so a coding agent can never receive the new prompt
 * while an old or missing context contract remains on disk. Registry and bind
 * refreshes use the best-effort wrapper above because a later refresh failure
 * must not terminate an already-running session.
 */
export async function writeHarnessContextForLaunch(
  session: WorkspaceContextSession,
  boundWorkflow: WorkflowInfo | null,
  workflows: WorkflowInfo[],
  isCurrent?: () => boolean,
): Promise<void> {
  const filePath = path.join(session.cwd, HARNESS_CONTEXT_FILE);
  const context = buildHarnessContext(session, boundWorkflow, workflows);

  await withPerPathQueue(filePath, async () => {
    await writeContextAtomically(filePath, context, isCurrent);
  });
}

export interface StagedHarnessContext {
  readonly filePath: string;
  /** Synchronous by design: a publisher commits every staged context and its
   * accepted cache/event snapshot without yielding between visible renames. */
  commit(): void;
  discard(): void;
}

/**
 * Prepares a context replacement without exposing it at HARNESS_CONTEXT_FILE.
 * Registry publication stages every active session asynchronously, rechecks
 * its generation/session projection, then calls commit() for all successful
 * stages in one non-yielding acceptance turn.
 */
export async function stageHarnessContextForPublication(
  session: WorkspaceContextSession,
  boundWorkflow: WorkflowInfo | null,
  workflows: WorkflowInfo[],
  isCurrent: () => boolean,
): Promise<StagedHarnessContext | null> {
  const filePath = path.join(session.cwd, HARNESS_CONTEXT_FILE);
  const context = buildHarnessContext(session, boundWorkflow, workflows);
  let staged: StagedHarnessContext | null = null;

  await withPerPathQueue(filePath, async () => {
    if (!isCurrent()) return;
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(
      dir,
      `.harness-context.json.stage-${process.pid}-${crypto.randomUUID()}`,
    );
    let settled = false;
    try {
      await fs.writeFile(
        tmpPath,
        `${JSON.stringify(context, null, 2)}\n`,
        "utf8",
      );
      if (!isCurrent()) return;
      staged = {
        filePath,
        commit: () => {
          if (settled) return;
          try {
            fsSync.renameSync(tmpPath, filePath);
          } finally {
            settled = true;
            try {
              fsSync.rmSync(tmpPath, { force: true });
            } catch {
              // The visible rename already succeeded or failed atomically.
            }
          }
        },
        discard: () => {
          if (settled) return;
          settled = true;
          try {
            fsSync.rmSync(tmpPath, { force: true });
          } catch {
            // Best-effort cleanup of an unpublished staging file.
          }
        },
      };
    } finally {
      if (!staged) await fs.rm(tmpPath, { force: true });
    }
  });

  return staged;
}

export type HarnessContextResumePreparation =
  | "current"
  | "migrated"
  | "rewritten";

interface LegacyHarnessWorkspaceContext {
  boundWorkflow: HarnessWorkspaceContextAgent | null;
  workflows: HarnessWorkspaceContextAgent[];
  session: HarnessWorkspaceContext["session"];
  updatedAt: string;
}

function buildHarnessContext(
  session: WorkspaceContextSession,
  boundWorkflow: WorkflowInfo | null,
  workflows: WorkflowInfo[],
): HarnessWorkspaceContext {
  const agents = [...workflows]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(toContextAgentEntry);
  return {
    boundAgent: boundWorkflow ? toContextAgentEntry(boundWorkflow) : null,
    agents,
    session: { id: session.id, cwd: session.cwd, harness: session.harness },
    updatedAt: new Date().toISOString(),
  };
}

async function writeContextAtomically(
  filePath: string,
  context: HarnessWorkspaceContext,
  isCurrent?: () => boolean,
): Promise<void> {
  if (isCurrent && !isCurrent()) return;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // A random suffix, not just pid+Date.now(): millisecond resolution is not
  // fine enough to stay unique across a burst of concurrent writes.
  const tmpPath = path.join(
    dir,
    `.harness-context.json.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await fs.writeFile(
      tmpPath,
      JSON.stringify(context, null, 2) + "\n",
      "utf8",
    );
    if (isCurrent && !isCurrent()) return;
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isContextAgent(value: unknown): value is HarnessWorkspaceContextAgent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["definitionId", "name", "path"])
  )
    return false;
  return (
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    (typeof value.definitionId === "number" || value.definitionId === null)
  );
}

function isContextSession(
  value: unknown,
): value is HarnessWorkspaceContext["session"] {
  if (!isRecord(value) || !hasExactKeys(value, ["cwd", "harness", "id"]))
    return false;
  return (
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    typeof value.harness === "string" &&
    SPAWNABLE_HARNESS_KINDS.some((harness) => harness === value.harness)
  );
}

function hasSharedValidFields(value: Record<string, unknown>): boolean {
  return isContextSession(value.session) && typeof value.updatedAt === "string";
}

function isCurrentContext(value: unknown): value is HarnessWorkspaceContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["agents", "boundAgent", "session", "updatedAt"])
  )
    return false;
  return (
    hasSharedValidFields(value) &&
    (value.boundAgent === null || isContextAgent(value.boundAgent)) &&
    Array.isArray(value.agents) &&
    value.agents.every(isContextAgent)
  );
}

function isLegacyContext(
  value: unknown,
): value is LegacyHarnessWorkspaceContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["boundWorkflow", "session", "updatedAt", "workflows"])
  ) {
    return false;
  }
  return (
    hasSharedValidFields(value) &&
    (value.boundWorkflow === null || isContextAgent(value.boundWorkflow)) &&
    Array.isArray(value.workflows) &&
    value.workflows.every(isContextAgent)
  );
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/**
 * Makes HARNESS_CONTEXT_FILE safe for a resumed coding agent before its new
 * Agent Studio prompt can reach the process. A valid current-schema file is
 * byte-for-byte untouched; a valid legacy file keeps its values and only
 * renames the two public keys; anything missing, malformed, mixed, or
 * incomplete is rebuilt from the live session and registry.
 *
 * Unlike ordinary registry/bind refreshes, this is strict: an unreadable file
 * or failed atomic replacement rejects resume so the prompt and on-disk
 * contract can never disagree during a launch.
 */
export async function prepareHarnessContextForResume(
  session: WorkspaceContextSession,
  boundWorkflow: WorkflowInfo | null,
  workflows: WorkflowInfo[],
): Promise<HarnessContextResumePreparation> {
  const filePath = path.join(session.cwd, HARNESS_CONTEXT_FILE);
  let result: HarnessContextResumePreparation = "rewritten";

  await withPerPathQueue(filePath, async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (!isMissingFileError(error) && !(error instanceof SyntaxError))
        throw error;
      await writeContextAtomically(
        filePath,
        buildHarnessContext(session, boundWorkflow, workflows),
      );
      result = "rewritten";
      return;
    }

    if (isCurrentContext(parsed)) {
      result = "current";
      return;
    }

    if (isLegacyContext(parsed)) {
      await writeContextAtomically(filePath, {
        boundAgent: parsed.boundWorkflow,
        agents: parsed.workflows,
        session: parsed.session,
        updatedAt: parsed.updatedAt,
      });
      result = "migrated";
      return;
    }

    await writeContextAtomically(
      filePath,
      buildHarnessContext(session, boundWorkflow, workflows),
    );
    result = "rewritten";
  });

  return result;
}
