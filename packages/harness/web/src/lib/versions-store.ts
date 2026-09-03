/**
 * One copy of an agent's version state, shared by every surface that shows it.
 *
 * Three surfaces read this at once: the Versions tab, the picker in that tab's
 * subheader, and the picker beside the agent name above the canvas. When each
 * held its own `useState` copy, a write in one left the others stale — resuming
 * "follow latest" from the tab cleared the tab's pin banner while the header
 * chip went on reading `· pinned`. Two surfaces disagreeing about whether
 * deploys go live is worse than either one being wrong alone, because there is
 * no way to tell which to believe.
 *
 * So the state lives here, keyed by definition, and every subscriber is
 * notified together. Kept as a plain class rather than a React hook so it is
 * unit-testable in the Node runner (the web tier only runs `lib/**.test.ts`).
 *
 * Snapshots are immutable and returned unchanged when nothing moved: that
 * identity stability is what `useSyncExternalStore` requires, and returning a
 * fresh object each call would re-render forever.
 *
 * Keyed by definition id ALONE, deliberately. `projectDir` only decides whether
 * the response can also describe the local working copy, and every caller
 * derives it from the same workflow — keying on it too would split the cache
 * back into the per-surface copies this exists to merge.
 */
import type { AgentVersionsView } from "@shared/types";

export interface VersionsSnapshot {
  readonly view: AgentVersionsView | null;
  readonly loading: boolean;
  /** Human-readable failure for the panel to show inline; null when fine. */
  readonly error: string | null;
  /** The sha whose write is in flight, so a row can show its own spinner. */
  readonly pendingSha: string | null;
}

/**
 * What every key reports before anything is loaded. A single frozen instance
 * because `useSyncExternalStore` compares snapshots by identity.
 */
export const EMPTY_SNAPSHOT: VersionsSnapshot = Object.freeze({
  view: null,
  loading: false,
  error: null,
  pendingSha: null,
});

export type VersionsFetcher = (
  definitionId: string,
  projectDir: string | null,
) => Promise<AgentVersionsView>;

export class VersionsStore {
  private readonly snapshots = new Map<string, VersionsSnapshot>();
  private readonly listeners = new Map<string, Set<() => void>>();
  /** Live request per key, so simultaneous mounts share one fetch. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Outstanding request count per key — `loading` must not clear early when a
   *  forced refetch overlaps the initial load. */
  private readonly running = new Map<string, number>();

  constructor(
    private readonly fetcher: VersionsFetcher,
    /** Turns a thrown value into the message surfaces show. */
    private readonly describeError: (err: unknown) => string = (err) =>
      err instanceof Error ? err.message : String(err),
  ) {}

  snapshot(definitionId: string): VersionsSnapshot {
    return this.snapshots.get(definitionId) ?? EMPTY_SNAPSHOT;
  }

  subscribe(definitionId: string, listener: () => void): () => void {
    let set = this.listeners.get(definitionId);
    if (!set) {
      set = new Set();
      this.listeners.set(definitionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(definitionId);
    };
  }

  private patch(definitionId: string, next: Partial<VersionsSnapshot>): void {
    this.snapshots.set(definitionId, { ...this.snapshot(definitionId), ...next });
    // Copied before iterating: a listener may unsubscribe as it runs.
    for (const listener of [...(this.listeners.get(definitionId) ?? [])]) {
      listener();
    }
  }

  /**
   * Fetch this agent's versions.
   *
   * Collapses concurrent callers onto one request: three surfaces mounting
   * together would otherwise fire three identical GETs, and each one re-packs
   * and re-hashes the project directory server-side to report the local copy.
   *
   * `force` is for after a write, where the whole point is to see new state.
   */
  load(
    definitionId: string,
    projectDir: string | null,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const running = this.inFlight.get(definitionId);
    if (running && !opts.force) return running;
    const task = this.run(definitionId, projectDir).finally(() => {
      // Identity-guarded: a forced refetch may already have replaced this
      // entry, and clearing it would let the next caller start a duplicate.
      if (this.inFlight.get(definitionId) === task) {
        this.inFlight.delete(definitionId);
      }
    });
    this.inFlight.set(definitionId, task);
    return task;
  }

  private async run(
    definitionId: string,
    projectDir: string | null,
  ): Promise<void> {
    this.begin(definitionId);
    try {
      const view = await this.fetcher(definitionId, projectDir);
      this.patch(definitionId, { view, error: null });
    } catch (err) {
      this.patch(definitionId, {
        view: null,
        error: this.describeError(err),
      });
    } finally {
      this.end(definitionId);
    }
  }

  private begin(definitionId: string): void {
    this.running.set(definitionId, (this.running.get(definitionId) ?? 0) + 1);
    this.patch(definitionId, { loading: true });
  }

  private end(definitionId: string): void {
    const left = (this.running.get(definitionId) ?? 1) - 1;
    if (left > 0) {
      this.running.set(definitionId, left);
      return;
    }
    this.running.delete(definitionId);
    this.patch(definitionId, { loading: false });
  }

  /**
   * Run a write, then refetch.
   *
   * The server is the source of truth for what a write did — activating the
   * newest build releases the pin as a side effect, and moving a label changes
   * two rows — so an optimistic local edit would drift from reality.
   */
  async mutate(
    definitionId: string,
    projectDir: string | null,
    sha: string | null,
    op: () => Promise<void>,
  ): Promise<void> {
    this.patch(definitionId, { pendingSha: sha, error: null });
    try {
      await op();
      await this.load(definitionId, projectDir, { force: true });
    } catch (err) {
      const message = this.describeError(err);
      // Refetch first, so a partial failure never leaves state on screen that
      // the server did not accept — then restate the write's own error, which
      // a successful refetch clears on its way past.
      await this.load(definitionId, projectDir, { force: true });
      this.patch(definitionId, { error: message });
    } finally {
      this.patch(definitionId, { pendingSha: null });
    }
  }
}
