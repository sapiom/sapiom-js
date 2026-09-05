import { realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import type { AnalyticsEvent } from "../shared/types.js";
import { inspectAgentProjectMarker } from "./agent-project-discovery.js";
import type { EventStore } from "./collector/store.js";
import type { StudioWorkspacePreferenceStore } from "./studio-workspace-preferences.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Recognize a completed scaffold, not a request, log line, or failed result. */
export function scaffoldCompletion(
  event: AnalyticsEvent,
): { dir: string; targetDir: string } | null {
  if (event.type !== "tool.call") return null;
  const { toolName, toolInput, toolResponseSummary } = event.payload;
  if (
    typeof toolName !== "string" ||
    !/^(?:mcp__[a-zA-Z0-9_-]+__)?sapiom_dev_agents_scaffold$/.test(toolName)
  )
    return null;
  const input = json(toolInput);
  if (!record(input) || typeof input.dir !== "string" || !input.dir.trim())
    return null;
  let output = json(toolResponseSummary);
  // Claude's hook carries the MCP content array. Codex can retain the envelope
  // (including isError) or the structured JSON result.
  if (record(output) && (output.isError === true || output.error != null))
    return null;
  if (record(output) && Array.isArray(output.content)) output = output.content;
  if (Array.isArray(output)) {
    if (output.length !== 1 || !record(output[0]) || output[0].type !== "text")
      return null;
    output = json(output[0].text);
  }
  if (
    !record(output) ||
    output.isError === true ||
    output.error != null ||
    typeof output.targetDir !== "string" ||
    !isAbsolute(output.targetDir) ||
    typeof output.projectName !== "string" ||
    !output.projectName ||
    typeof output.dependenciesInstalled !== "boolean" ||
    typeof output.gitInitialized !== "boolean"
  )
    return null;
  return { dir: input.dir, targetDir: output.targetDir };
}

interface Creator {
  projectId: string;
  cwd: string;
}

export interface CreatedAgentRegistrationOptions {
  preferences: StudioWorkspacePreferenceStore;
  events: EventStore;
  /** Revalidate the server-owned session/principal, and live runtime if given. */
  authorize: (
    event: AnalyticsEvent,
    runtimeEpoch?: string,
  ) => Promise<Creator | null>;
  /** Null means unclaimed; a foreign project must never be absorbed. */
  projectForPath: (path: string) => Promise<string | null>;
  scan: (path: string) => Promise<void>;
  watch: (path: string) => void;
}

/** Successful creation -> durable ownership -> exact scan -> live observation. */
export class CreatedAgentRegistration {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private observed = new Set<string>();

  constructor(private readonly options: CreatedAgentRegistrationOptions) {}

  onEventPersisted(
    event: AnalyticsEvent,
    runtimeEpoch?: string,
  ): Promise<void> {
    const completion = scaffoldCompletion(event);
    if (this.closed || !completion) return Promise.resolve();
    const result = this.queue.then(async () => {
      if (this.closed) return;
      const creator = await this.options.authorize(event, runtimeEpoch);
      if (!creator) return;
      let target: string;
      try {
        // Fresh realpath (not the graph cache): aliases must match, and a
        // historical completion is not proof that a folder still exists.
        target = await realpath(completion.targetDir);
        if (target !== (await realpath(resolve(creator.cwd, completion.dir))))
          return;
      } catch {
        return;
      }
      const inspection = await inspectAgentProjectMarker(target);
      if (inspection.status !== "valid") return;
      const owner = await this.options.projectForPath(target);
      if (owner && owner !== creator.projectId) return;
      // Filesystem/catalog checks yielded: logout, resume, or close can race.
      const current = await this.options.authorize(event, runtimeEpoch);
      if (
        this.closed ||
        current?.projectId !== creator.projectId ||
        current.cwd !== creator.cwd
      )
        return;
      const registered = await this.options.preferences.registerCreatedAgent(
        creator.projectId,
        event.harnessSessionId,
        {
          path: target,
          name:
            typeof inspection.marker.name === "string" && inspection.marker.name
              ? inspection.marker.name
              : basename(target),
          definitionId: Number.isSafeInteger(inspection.marker.definitionId)
            ? inspection.marker.definitionId!
            : null,
        },
      );
      if (!registered || this.closed) return;
      this.options.watch(target);
      await this.options.scan(target);
      this.observed.add(target);
    });
    this.queue = result.catch(() => {});
    return result;
  }

  /** Backfill only recorded successful creations, never infer from siblings. */
  async recover(sessionIds: readonly string[]): Promise<void> {
    for await (const event of this.options.events.read({
      harnessSessionId: sessionIds,
      types: ["tool.call"],
    })) {
      await this.onEventPersisted(event);
    }
    // Membership outlives both analytics retention and its creating session.
    for (const binding of await this.options.preferences.createdAgents()) {
      if (this.closed) return;
      if (this.observed.has(binding.path)) continue;
      const owner = await this.options.projectForPath(binding.path);
      if (owner && owner !== binding.projectId) continue;
      this.options.watch(binding.path);
      await this.options.scan(binding.path);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}
