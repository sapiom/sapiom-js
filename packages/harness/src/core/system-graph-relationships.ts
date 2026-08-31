import * as path from "node:path";

import {
  scanWorkflowSources,
  type AgentInvocationDetectionWarning,
  type AgentInvocationMode,
  type SourceEvidence,
  type WorkflowSourceReadHooks,
} from "./canvas-interconnections.js";
import { fingerprintWorkflowSources } from "./canvas-cache.js";
import { canonicalGraphPath } from "./canonical-graph-path.js";
import type { AgentInventoryItem } from "./system-graph-inventory.js";

export const INVOCATION_OBSERVATION_MAX_PATHS = 10_000;

export interface AgentInvocationCandidate {
  /** Inventory key or definition slug to resolve after extraction. */
  target: string;
  mode: AgentInvocationMode;
  /** Internal-only evidence retained across callsite deduplication. */
  evidence: SourceEvidence[];
}

export type AgentInvocationWarning = AgentInvocationDetectionWarning;

export interface AgentInvocationProviderResult {
  invocations: AgentInvocationCandidate[];
  warnings: AgentInvocationWarning[];
  /** Confined files considered by this bounded extraction generation. */
  observedPaths?: readonly string[];
  /** False when an opaque path or work cap prevented a complete scan. */
  complete?: boolean;
  /** Stable content digest supplied by the authoritative source scan. */
  sourceFingerprint?: `sha256:${string}`;
}

export interface AgentInvocationSnapshot {
  status: "ready" | "failed";
  result: AgentInvocationProviderResult;
}

export interface AgentInvocationObservation {
  candidateRoot: string;
  workspaceRoot: string;
  paths: readonly string[];
}

/**
 * Replaceable per-caller boundary for literal direct invocations consumed by
 * the workspace graph projector. The caller is always the source endpoint.
 */
export interface AgentInvocationProvider {
  listInvocations(
    caller: AgentInventoryItem,
  ): Promise<AgentInvocationProviderResult>;
  /** Optional lifecycle hook for providers that retain per-caller state. */
  retainCallers?(callers: readonly AgentInventoryItem[]): void;
  /** Cache-only projection used by the first graph phase. */
  peekInvocations?(
    caller: AgentInventoryItem,
  ): AgentInvocationSnapshot | undefined;
  /** Starts bounded work only after the inventory-only graph is committed. */
  startInvocations?(callers: readonly AgentInventoryItem[]): void;
  /** Accepted/current invocation metadata consumed by polling watchers. */
  invocationObservations?(): readonly AgentInvocationObservation[];
}

interface CachedInvocationEntry {
  fingerprint: string;
  result: Promise<AgentInvocationProviderResult>;
}

interface InvocationTask {
  sourceRoot: string;
  caller: AgentInventoryItem;
  generation: number;
  scopeEpoch: number;
}

interface BackgroundInvocationEntry {
  generation: number;
  scopeEpoch: number;
  snapshot?: AgentInvocationSnapshot;
}

export interface CachedAgentInvocationProviderOptions {
  concurrency?: number;
  onChange?: (sourceRoots: readonly string[]) => void | Promise<void>;
  /** Small testable coalescing window; settled scopes never await global idle. */
  changeBatchMs?: number;
}

/**
 * Successful per-caller invocation extraction behind the same cheap source
 * fingerprint used by Canvas. Projection can therefore rebuild against a new
 * inventory without re-walking unchanged caller trees.
 */
export class CachedAgentInvocationProvider implements AgentInvocationProvider {
  private readonly entries = new Map<string, CachedInvocationEntry>();
  private readonly background = new Map<string, BackgroundInvocationEntry>();
  private readonly queued: InvocationTask[] = [];
  private readonly active = new Map<string, InvocationTask>();
  private readonly pendingChanges = new Set<string>();
  private readonly invalidatedScopes = new Map<string, number>();
  private nextGeneration = 1;
  private nextScopeEpoch = 1;
  private activeCount = 0;
  private observationsTruncated = false;
  private changeFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly inner: AgentInvocationProvider = new SourceAgentInvocationProvider(),
    private readonly fingerprint: (
      sourceRoot: string,
    ) => Promise<string> = fingerprintWorkflowSources,
    private readonly options: CachedAgentInvocationProviderOptions = {},
  ) {}

  async listInvocations(
    caller: AgentInventoryItem,
  ): Promise<AgentInvocationProviderResult> {
    const key = canonicalGraphPath(caller.sourceRoot);
    let fingerprint: string;
    try {
      fingerprint = await this.fingerprint(key);
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }

    const hit = this.entries.get(key);
    if (hit?.fingerprint === fingerprint) return hit.result;

    let result: Promise<AgentInvocationProviderResult>;
    try {
      result = Promise.resolve(this.inner.listInvocations(caller));
    } catch (error) {
      result = Promise.reject(error);
    }
    const entry = { fingerprint, result };
    this.entries.set(key, entry);
    void result.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return result;
  }

  invalidateSource(sourceRoot: string): void {
    const key = canonicalGraphPath(sourceRoot);
    this.entries.delete(key);
    this.background.set(key, {
      generation: this.nextGeneration++,
      scopeEpoch: this.scopeEpochForSource(key),
    });
    this.dropQueued(key);
    this.pendingChanges.delete(key);
  }

  /** O(1) conservative invalidation for an ambiguous workspace event. */
  invalidateScope(scopeRoot: string): void {
    this.invalidatedScopes.set(
      canonicalGraphPath(scopeRoot),
      this.nextScopeEpoch++,
    );
  }

  /** Explicit graph Retry re-arms terminal failures without read-loop churn. */
  retryFailed(scopeRoot: string): void {
    const root = canonicalGraphPath(scopeRoot);
    for (const [sourceRoot, entry] of this.background) {
      const relative = path.relative(root, sourceRoot);
      if (
        (entry.snapshot?.status !== "failed" &&
          !(
            entry.snapshot?.status === "ready" &&
            entry.snapshot.result.complete === false
          )) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        continue;
      }
      this.background.set(sourceRoot, {
        generation: this.nextGeneration++,
        scopeEpoch: this.scopeEpochForSource(sourceRoot),
      });
      this.dropQueued(sourceRoot);
    }
  }

  retainCallers(callers: readonly AgentInventoryItem[]): void {
    const retained = new Set(
      callers.map((caller) => canonicalGraphPath(caller.sourceRoot)),
    );
    for (const sourceRoot of this.entries.keys()) {
      if (!retained.has(sourceRoot)) this.entries.delete(sourceRoot);
    }
    for (const sourceRoot of this.background.keys()) {
      if (retained.has(sourceRoot)) continue;
      this.background.delete(sourceRoot);
      this.dropQueued(sourceRoot);
      this.pendingChanges.delete(sourceRoot);
    }
    for (const scopeRoot of this.invalidatedScopes.keys()) {
      if (
        [...retained].some((sourceRoot) =>
          this.scopeContainsSource(scopeRoot, sourceRoot),
        )
      ) {
        continue;
      }
      this.invalidatedScopes.delete(scopeRoot);
    }
    this.refreshObservationCoverage();
  }

  clear(): void {
    this.entries.clear();
    this.background.clear();
    this.queued.length = 0;
    this.pendingChanges.clear();
    if (this.changeFlushTimer) clearTimeout(this.changeFlushTimer);
    this.changeFlushTimer = null;
    this.invalidatedScopes.clear();
    this.nextGeneration += 1;
    this.nextScopeEpoch += 1;
    this.observationsTruncated = false;
  }

  peekInvocations(
    caller: AgentInventoryItem,
  ): AgentInvocationSnapshot | undefined {
    const sourceRoot = canonicalGraphPath(caller.sourceRoot);
    const entry = this.background.get(sourceRoot);
    if (entry?.scopeEpoch !== this.scopeEpochForSource(sourceRoot)) {
      return undefined;
    }
    if (
      this.observationsTruncated &&
      entry.snapshot?.status === "ready" &&
      entry.snapshot.result.complete !== false
    ) {
      return {
        status: "ready",
        result: { ...entry.snapshot.result, complete: false },
      };
    }
    return entry.snapshot;
  }

  startInvocations(callers: readonly AgentInventoryItem[]): void {
    for (const caller of callers) {
      const sourceRoot = canonicalGraphPath(caller.sourceRoot);
      let entry = this.background.get(sourceRoot);
      const scopeEpoch = this.scopeEpochForSource(sourceRoot);
      if (!entry || entry.scopeEpoch !== scopeEpoch) {
        entry = { generation: this.nextGeneration++, scopeEpoch };
        this.background.set(sourceRoot, entry);
        this.dropQueued(sourceRoot);
      }
      if (entry.snapshot) continue;
      if (
        this.active.get(sourceRoot)?.generation === entry.generation ||
        this.queued.some(
          (task) =>
            task.sourceRoot === sourceRoot &&
            task.generation === entry!.generation,
        )
      ) {
        continue;
      }
      this.dropQueued(sourceRoot);
      this.queued.push({
        sourceRoot,
        caller,
        generation: entry.generation,
        scopeEpoch: entry.scopeEpoch,
      });
    }
    this.drain();
  }

  invocationObservations(): readonly AgentInvocationObservation[] {
    const entries = [...this.background.entries()]
      .filter(
        ([sourceRoot, entry]) =>
          entry.scopeEpoch === this.scopeEpochForSource(sourceRoot) &&
          (entry.snapshot?.result.observedPaths?.length ?? 0) > 0,
      )
      .sort(([left], [right]) => left.localeCompare(right));
    const selected = new Map<string, string[]>();
    let remaining = INVOCATION_OBSERVATION_MAX_PATHS;
    let round = 0;
    while (remaining > 0) {
      let added = false;
      for (const [sourceRoot, entry] of entries) {
        if (remaining === 0) break;
        const observed = entry.snapshot?.result.observedPaths?.[round];
        if (!observed) continue;
        const paths = selected.get(sourceRoot) ?? [];
        paths.push(observed);
        selected.set(sourceRoot, paths);
        remaining -= 1;
        added = true;
      }
      if (!added) break;
      round += 1;
    }
    return [...selected.entries()].map(([sourceRoot, paths]) => ({
      candidateRoot: sourceRoot,
      workspaceRoot: sourceRoot,
      paths,
    }));
  }

  private current(task: InvocationTask): boolean {
    const entry = this.background.get(task.sourceRoot);
    return (
      entry?.generation === task.generation &&
      entry.scopeEpoch === task.scopeEpoch &&
      task.scopeEpoch === this.scopeEpochForSource(task.sourceRoot)
    );
  }

  private scopeContainsSource(scopeRoot: string, sourceRoot: string): boolean {
    const relative = path.relative(scopeRoot, sourceRoot);
    return (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }

  private scopeEpochForSource(sourceRoot: string): number {
    let epoch = 0;
    for (const [scopeRoot, candidateEpoch] of this.invalidatedScopes) {
      if (this.scopeContainsSource(scopeRoot, sourceRoot)) {
        epoch = Math.max(epoch, candidateEpoch);
      }
    }
    return epoch;
  }

  private refreshObservationCoverage(): void {
    let count = 0;
    let truncated = false;
    for (const [sourceRoot, entry] of this.background) {
      if (entry.scopeEpoch !== this.scopeEpochForSource(sourceRoot)) continue;
      count += entry.snapshot?.result.observedPaths?.length ?? 0;
      if (count > INVOCATION_OBSERVATION_MAX_PATHS) {
        truncated = true;
        break;
      }
    }
    if (truncated === this.observationsTruncated) return;
    this.observationsTruncated = truncated;
    // Coverage is part of every retained ready snapshot's effective
    // completeness. Crossing the global observation cap (in either direction)
    // therefore changes more than the task that happened to settle/retire.
    for (const [sourceRoot, entry] of this.background) {
      if (
        entry.snapshot &&
        entry.scopeEpoch === this.scopeEpochForSource(sourceRoot)
      ) {
        this.pendingChanges.add(sourceRoot);
      }
    }
    this.scheduleChanges();
  }

  private dropQueued(sourceRoot: string): void {
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      if (this.queued[index]!.sourceRoot === sourceRoot) {
        this.queued.splice(index, 1);
      }
    }
  }

  private drain(): void {
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      if (!this.current(this.queued[index]!)) this.queued.splice(index, 1);
    }
    const concurrency = Math.max(1, this.options.concurrency ?? 4);
    while (this.activeCount < concurrency) {
      const index = this.queued.findIndex(
        (task) => !this.active.has(task.sourceRoot),
      );
      if (index === -1) break;
      const [task] = this.queued.splice(index, 1);
      if (!task || !this.current(task)) continue;
      this.active.set(task.sourceRoot, task);
      this.activeCount += 1;
      void this.run(task).finally(() => {
        if (this.active.get(task.sourceRoot) === task) {
          this.active.delete(task.sourceRoot);
          this.activeCount -= 1;
        }
        this.drain();
      });
    }
  }

  private async run(task: InvocationTask): Promise<void> {
    let snapshot: AgentInvocationSnapshot;
    try {
      snapshot = {
        status: "ready",
        result: await this.inner.listInvocations(task.caller),
      };
    } catch {
      snapshot = {
        status: "failed",
        result: { invocations: [], warnings: [] },
      };
    }
    if (!this.current(task)) return;
    this.background.set(task.sourceRoot, {
      generation: task.generation,
      scopeEpoch: task.scopeEpoch,
      snapshot,
    });
    this.refreshObservationCoverage();
    this.pendingChanges.add(task.sourceRoot);
    this.scheduleChanges();
  }

  private scheduleChanges(): void {
    if (this.changeFlushTimer) return;
    this.changeFlushTimer = setTimeout(() => {
      this.changeFlushTimer = null;
      this.flushChanges();
    }, this.options.changeBatchMs ?? 0);
  }

  private flushChanges(): void {
    if (this.pendingChanges.size === 0) return;
    const changed = [...this.pendingChanges]
      .filter((sourceRoot) => {
        const entry = this.background.get(sourceRoot);
        return (
          entry?.snapshot !== undefined &&
          entry.scopeEpoch === this.scopeEpochForSource(sourceRoot)
        );
      })
      .sort();
    this.pendingChanges.clear();
    if (changed.length === 0) return;
    void Promise.resolve()
      .then(() => this.options.onChange?.(changed))
      .catch(() => {
        // Refresh hints cannot invalidate current invocation evidence.
      });
  }
}

function evidenceOrder(left: SourceEvidence, right: SourceEvidence): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column
  );
}

const MODE_ORDER: Record<AgentInvocationMode, number> = {
  blocking: 0,
  async: 1,
};

/**
 * V0 per-agent filesystem adapter for literal direct invocations.
 *
 * It scans only the caller's inventoried source root. It remains syntax-only
 * and has no inventory target resolution, input-provenance analysis, package
 * router scan, renderer, transport, deployment, or session dependencies.
 */
export class SourceAgentInvocationProvider implements AgentInvocationProvider {
  constructor(private readonly readHooks: WorkflowSourceReadHooks = {}) {}

  async listInvocations(
    caller: AgentInventoryItem,
  ): Promise<AgentInvocationProviderResult> {
    const scan = await scanWorkflowSources(
      caller.sourceRoot,
      new Set(),
      this.readHooks,
    );
    const grouped = new Map<string, AgentInvocationCandidate>();

    for (const detectedInvocation of scan.invocations) {
      const key = `${detectedInvocation.slug}\0${detectedInvocation.mode}`;
      const candidate = grouped.get(key);
      if (candidate) {
        candidate.evidence.push(detectedInvocation.evidence);
      } else {
        grouped.set(key, {
          target: detectedInvocation.slug,
          mode: detectedInvocation.mode,
          evidence: [detectedInvocation.evidence],
        });
      }
    }

    const invocations = [...grouped.values()];
    for (const candidate of invocations) {
      candidate.evidence.sort(evidenceOrder);
    }
    invocations.sort(
      (left, right) =>
        left.evidence[0]!.file.localeCompare(right.evidence[0]!.file) ||
        left.evidence[0]!.line - right.evidence[0]!.line ||
        left.evidence[0]!.column - right.evidence[0]!.column ||
        MODE_ORDER[left.mode] - MODE_ORDER[right.mode] ||
        left.target.localeCompare(right.target),
    );

    return {
      invocations,
      warnings: scan.invocationWarnings,
      observedPaths: scan.observedPaths,
      complete: scan.complete,
      sourceFingerprint: scan.sourceFingerprint,
    };
  }
}
