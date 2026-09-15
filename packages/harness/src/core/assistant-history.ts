import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  AssistantHistoryEntry,
  AssistantHistoryList,
} from "../shared/assistant-history.js";
import type { HarnessSession } from "../shared/types.js";
import type { AssistantRecordStore } from "./assistant-record-store.js";
import type { AssistantAssociation } from "./assistant-session-store.js";
import type { AssistantLifecycleCoordinator } from "./assistant-lifecycle.js";
import { OpenCodeAccessError } from "./opencode-host.js";

interface Options {
  sessions: {
    list(): HarnessSession[];
    get(id: string): HarnessSession | undefined;
  };
  authorize: ((id: string) => Promise<AssistantAssociation | null>) & {
    /** Existing access owner supplies a synchronous fence for final filesystem awaits. */
    captureAuthority?: () => () => void;
  };
  records: Pick<AssistantRecordStore, "read">;
  lifecycle: Pick<AssistantLifecycleCoordinator, "describe">;
  /** Pending continuation children are not discoverable until preparation commits. */
  isVisible?: (id: string) => Promise<boolean>;
}

/** Metadata-only discovery. Native availability is checked separately for a selected entry. */
export class AssistantHistory {
  constructor(private readonly options: Options) {}

  async entry(id: string): Promise<AssistantHistoryEntry | null> {
    return (await this.read(id))?.entry ?? null;
  }

  private async read(id: string): Promise<{
    entry: AssistantHistoryEntry;
    binding: AssistantAssociation;
  } | null> {
    const assertAuthority = this.options.authorize.captureAuthority?.();
    const session = this.options.sessions.get(id);
    if (!session) return null;
    const workspaceCwd = session.cwd;
    const project = JSON.stringify([session.harness, session.agentMapIdentity]);
    if (this.options.isVisible && !(await this.options.isVisible(id)))
      return null;
    const binding = await this.options.authorize(id);
    if (!binding) return null;
    if ((await realpath(workspaceCwd)) !== binding.cwd)
      throw new OpenCodeAccessError("Workspace changed");
    const lifecycle = await this.options.lifecycle.describe(id);
    let history: AssistantHistoryEntry["history"] = "unavailable";
    let recordRevision: number | null = null;
    let updatedAt = session.lastActiveAt;
    try {
      const { harnessSessionId, contextAuthorityScope, conversationId, cwd } =
        binding;
      const record = await this.options.records.read({
        harnessSessionId,
        contextAuthorityScope,
        conversationId,
        cwd,
      });
      history = !record
        ? "missing"
        : record.limitations.length ||
            record.turns.some((turn) => turn.incomplete)
          ? "partial"
          : "available";
      recordRevision = record?.revision ?? null;
      updatedAt = record?.capturedAt ?? updatedAt;
    } catch {
      // Storage failure is distinct from an authorized binding with no checkpoint.
    }
    if (
      JSON.stringify(await this.options.authorize(id)) !==
      JSON.stringify(binding)
    )
      throw new OpenCodeAccessError("Assistant binding changed");
    if (this.options.isVisible && !(await this.options.isVisible(id)))
      return null;
    const canonicalCwd = await realpath(workspaceCwd);
    const current = this.options.sessions.get(id);
    if (
      !current ||
      current.cwd !== workspaceCwd ||
      canonicalCwd !== binding.cwd ||
      JSON.stringify([current.harness, current.agentMapIdentity]) !== project
    )
      throw new OpenCodeAccessError("Workspace changed");
    assertAuthority?.();
    return {
      binding,
      entry: {
        kind: "assistant",
        harnessSessionId: id,
        title: current.title,
        cwd: binding.cwd,
        workspace: { cwd: workspaceCwd, canonicalCwd: binding.cwd },
        createdAt: current.createdAt,
        updatedAt,
        lifecycle,
        history,
        nativeResume: "unchecked",
        recordRevision,
        ...(current.agentMapIdentity
          ? {
              continuationScope: createHash("sha256")
                .update(
                  JSON.stringify([
                    "studio-assistant-continue-retry/v1",
                    binding.contextAuthorityScope,
                    binding.conversationId,
                    current.agentMapIdentity.projectId,
                    current.agentMapIdentity.userId,
                    current.harness,
                  ]),
                )
                .digest("hex"),
            }
          : {}),
      },
    };
  }

  async list(cwd: string): Promise<AssistantHistoryEntry[]> {
    return (await this.listWithWorkspace(cwd)).entries;
  }

  async listWithWorkspace(cwd: string): Promise<AssistantHistoryList> {
    const assertAuthority = this.options.authorize.captureAuthority?.();
    if (!isAbsolute(cwd) || cwd.length > 4096)
      throw new OpenCodeAccessError("Workspace unavailable");
    const canonical = await realpath(cwd);
    const sessions = this.options.sessions.list();
    const entries: {
      entry: AssistantHistoryEntry;
      binding: AssistantAssociation;
    }[] = [];
    // Bound filesystem concurrency when a workspace has a long history.
    for (let offset = 0; offset < sessions.length; offset += 8) {
      const page = await Promise.allSettled(
        sessions.slice(offset, offset + 8).map(async (session) => {
          try {
            if ((await realpath(session.cwd)) !== canonical) return null;
            const entry = await this.read(session.id);
            return entry?.entry.cwd === canonical ? entry : null;
          } catch (error) {
            if (
              error instanceof OpenCodeAccessError ||
              (error as NodeJS.ErrnoException).code === "ENOENT"
            )
              return null;
            throw error;
          }
        }),
      );
      for (const result of page) {
        if (result.status === "rejected") throw result.reason;
        if (result.value) entries.push(result.value);
      }
    }
    // Revalidate the complete result after IO for the other entries. No old
    // authority's titles or existence may escape on a mid-list account change.
    for (const { entry, binding: previous } of entries) {
      if (
        this.options.isVisible &&
        !(await this.options.isVisible(entry.harnessSessionId))
      )
        throw new OpenCodeAccessError("Assistant preparation changed");
      const binding = await this.options.authorize(entry.harnessSessionId);
      if (!binding || JSON.stringify(binding) !== JSON.stringify(previous))
        throw new OpenCodeAccessError("Assistant access changed");
    }
    const canonicalCwds = await Promise.all([
      realpath(cwd),
      ...entries.map(({ entry }) => realpath(entry.workspace!.cwd)),
    ]);
    if (
      canonicalCwds.some((path) => path !== canonical) ||
      entries.some(
        ({ entry }) =>
          this.options.sessions.get(entry.harnessSessionId)?.cwd !==
          entry.workspace!.cwd,
      )
    )
      throw new OpenCodeAccessError("Workspace changed");
    assertAuthority?.();
    return {
      workspace: { cwd, canonicalCwd: canonical },
      entries: entries
        .map(({ entry }) => entry)
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) ||
            a.harnessSessionId.localeCompare(b.harnessSessionId),
        ),
    };
  }
}
