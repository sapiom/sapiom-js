import {
  findRolloutCandidates,
  type CodexRolloutCandidate,
} from "./codex-tailer.js";

export type CodexRolloutClaimResult =
  | Readonly<{ outcome: "claimed"; path: string }>
  | Readonly<{ outcome: "pending" | "ambiguous"; path: null }>;

type PendingRuntime = Readonly<{
  sessionId: string;
  runtimeEpoch: string;
  cwd: string;
  sinceMs: number;
  requiredRuntimeMarker?: string;
}>;

const runtimeKey = (sessionId: string, runtimeEpoch: string) =>
  `${sessionId}\0${runtimeEpoch}`;

/**
 * Process-epoch rollout ownership for fresh Codex sessions. A path is claimed
 * at most once. Singleton elimination across every same-root pending launch
 * handles the common A={a,b}, B={b} race without guessing; an unresolved
 * many-to-many match remains explicitly ambiguous.
 */
export class CodexRolloutBroker {
  private readonly pending = new Map<string, PendingRuntime>();
  private readonly assignments = new Map<string, string>();
  private readonly claimedPaths = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly homeDir?: string) {}

  register(input: PendingRuntime): void {
    const key = runtimeKey(input.sessionId, input.runtimeEpoch);
    if (this.assignments.has(key) || this.pending.has(key)) return;
    this.pending.set(key, { ...input });
  }

  release(sessionId: string, runtimeEpoch: string): void {
    const key = runtimeKey(sessionId, runtimeEpoch);
    this.pending.delete(key);
    const assigned = this.assignments.get(key);
    this.assignments.delete(key);
    // Keep the path tombstone. A rollout is never adopted by another Harness
    // session, though an exact resume of the same session may reclaim it.
    void assigned;
  }

  releaseSession(sessionId: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.pending.delete(key);
    }
    for (const key of this.assignments.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.assignments.delete(key);
    }
  }

  async claimExact(
    input: PendingRuntime & { agentSessionId: string },
  ): Promise<CodexRolloutClaimResult> {
    return this.serialized(async () => {
      const key = runtimeKey(input.sessionId, input.runtimeEpoch);
      const assigned = this.assignments.get(key);
      if (assigned) return { outcome: "claimed", path: assigned } as const;
      const candidates = await findRolloutCandidates({
        cwd: input.cwd,
        agentSessionId: input.agentSessionId,
        homeDir: this.homeDir,
      });
      const candidate = candidates.find(({ path }) => {
        const owner = this.claimedPaths.get(path);
        return !owner || owner.startsWith(`${input.sessionId}\0`);
      });
      if (!candidate) return { outcome: "pending", path: null } as const;
      this.assign(key, candidate.path, input.sessionId);
      return { outcome: "claimed", path: candidate.path } as const;
    });
  }

  async claimFresh(input: PendingRuntime): Promise<CodexRolloutClaimResult> {
    this.register(input);
    return this.serialized(async () => {
      const key = runtimeKey(input.sessionId, input.runtimeEpoch);
      const assigned = this.assignments.get(key);
      if (assigned) return { outcome: "claimed", path: assigned } as const;

      const group = [...this.pending.entries()].filter(
        ([, candidate]) => candidate.cwd === input.cwd,
      );
      const possibilities = new Map<string, CodexRolloutCandidate[]>();
      for (const [candidateKey, pending] of group) {
        possibilities.set(
          candidateKey,
          await findRolloutCandidates({
            cwd: pending.cwd,
            sinceMs: pending.sinceMs,
            homeDir: this.homeDir,
            excludePaths: new Set(this.claimedPaths.keys()),
            ...(pending.requiredRuntimeMarker
              ? { requiredRuntimeMarker: pending.requiredRuntimeMarker }
              : { excludeRuntimeMarkers: true }),
          }),
        );
      }

      // Discovery awaits filesystem I/O. A runtime released during that wait
      // must not receive a path or leave a tombstone for a later live session.
      for (const candidateKey of possibilities.keys()) {
        if (!this.pending.has(candidateKey)) possibilities.delete(candidateKey);
      }

      let changed = true;
      while (changed) {
        changed = false;
        const singles = [...possibilities.entries()]
          .filter(([, candidates]) => candidates.length === 1)
          .sort(([left], [right]) => left.localeCompare(right));
        for (const [candidateKey, [candidate]] of singles) {
          if (!candidate || this.claimedPaths.has(candidate.path)) continue;
          this.assign(candidateKey, candidate.path);
          possibilities.delete(candidateKey);
          for (const remaining of possibilities.values()) {
            const index = remaining.findIndex(
              ({ path }) => path === candidate.path,
            );
            if (index >= 0) remaining.splice(index, 1);
          }
          changed = true;
        }
      }

      const resolved = this.assignments.get(key);
      if (resolved) return { outcome: "claimed", path: resolved } as const;
      const remaining = possibilities.get(key) ?? [];
      return {
        outcome: remaining.length > 1 ? "ambiguous" : "pending",
        path: null,
      } as const;
    });
  }

  private assign(key: string, path: string, resumableSessionId?: string): void {
    const owner = this.claimedPaths.get(path);
    if (owner && !owner.startsWith(`${resumableSessionId ?? ""}\0`)) return;
    this.assignments.set(key, path);
    this.claimedPaths.set(path, key);
    this.pending.delete(key);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
