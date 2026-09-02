import * as fs from "node:fs";
import * as path from "node:path";

import { isAgentProjectScanIgnoredDir } from "./agent-project-discovery.js";
import { normalizeWatchPath } from "./canvas-watcher.js";
import { canonicalGraphPath } from "./canonical-graph-path.js";
import {
  snapshotWorkflowSourceRootsAsync,
  snapshotWorkspaceWorkflowsAsync,
  type WorkflowSourceObservation,
} from "./workspace-watcher.js";

const SOURCE_DEBOUNCE_MS = 150;
const INVENTORY_DEBOUNCE_MS = 250;
const INVENTORY_RETRY_BASE_MS = 500;
const MAX_INVENTORY_RETRIES = 3;
const MAX_SOURCE_RETRIES = 3;
const POLL_INTERVAL_MS = 2_000;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function ignoredRelativePath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  const ignoredIndex = segments.findIndex((segment) =>
    isAgentProjectScanIgnoredDir(segment),
  );
  // Creating/removing the boundary directory itself (notably `agent/.git`)
  // changes whether a parent scan is allowed to own that candidate. Churn
  // below an established boundary remains ignored.
  return ignoredIndex >= 0 && ignoredIndex < segments.length - 1;
}

function sourceRelativePath(relativePath: string): boolean {
  return (
    !ignoredRelativePath(relativePath) &&
    SOURCE_EXTENSIONS.has(path.extname(relativePath))
  );
}

function confinedSourcePath(root: string, relativePath: string): string | null {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return absolute;
}

function isNestedSourceRoot(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function changedSourceRoots(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): string[] {
  const changed = [...new Set([...previous.keys(), ...current.keys()])].filter(
    (root) => previous.get(root) !== current.get(root),
  );
  return deepestSourceRoots(changed);
}

function deepestSourceRoots(roots: readonly string[]): string[] {
  // Nested registered projects appear in their parent's recursive snapshot.
  // Attribute the edit only to the deepest changed caller(s).
  return [...new Set(roots)]
    .filter(
      (root) =>
        !roots.some(
          (candidate) =>
            candidate !== root && isNestedSourceRoot(root, candidate),
        ),
    )
    .sort();
}

interface SourceSnapshotRequest {
  roots: readonly string[];
  observations: readonly WorkflowSourceObservation[];
  signature: string;
}

interface SourceSnapshotSample {
  request: SourceSnapshotRequest;
  snapshots: ReadonlyMap<string, string>;
  changedRoots: readonly string[];
  baselineRequest: SourceSnapshotRequest | null;
  baselineSnapshots: ReadonlyMap<string, string> | null;
}

function sourceSnapshotRequest(
  roots: readonly string[],
  observations: readonly WorkflowSourceObservation[],
): SourceSnapshotRequest {
  const retainedRoots = [...roots];
  const retainedObservations = observations.map((observation) => ({
    workspaceRoot: observation.workspaceRoot,
    candidateRoot: observation.candidateRoot,
    paths: [...observation.paths],
  }));
  const samplingDeclaration = retainedObservations.map((observation) => [
    path.resolve(observation.workspaceRoot),
    path.resolve(observation.candidateRoot),
    observation.paths,
  ]);
  return {
    roots: retainedRoots,
    observations: retainedObservations,
    signature: JSON.stringify([
      retainedRoots.map((root) => path.resolve(root)),
      samplingDeclaration,
    ]),
  };
}

export interface WorkspaceWatchCallbacks {
  /** Current registry roots inside this root; read lazily on every poll. */
  listSourceRoots: () => readonly string[];
  listSourceObservations?: () => readonly WorkflowSourceObservation[];
  onSourceChange: (
    /** Null when the platform can only report a workspace-level change. */
    sourcePaths: readonly string[] | null,
  ) => void | Promise<void>;
  onInventoryChange: () => void | Promise<void>;
  /** Synchronous raw-event fail-close hook, before debounce or async I/O. */
  onPotentialChange?: (sourcePaths: readonly string[] | null) => void;
}

export interface WorkspaceWatchHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): WorkspaceWatchHandle;
}

export type WorkspaceWatchFactory = (
  root: string,
  listener: (event: "rename" | "change", filename: string | null) => void,
) => WorkspaceWatchHandle;

export interface WorkspaceWatchOptions {
  sourceDebounceMs?: number;
  inventoryDebounceMs?: number;
  inventoryRetryBaseMs?: number;
  maxInventoryRetries?: number;
  maxSourceRetries?: number;
  pollIntervalMs?: number;
  /** Deterministic test seam for the supported polling fallback. */
  forcePolling?: boolean;
  /** Deterministic test seam for native event routing and watcher errors. */
  watchFactory?: WorkspaceWatchFactory;
  /** Deterministic lifecycle seam: the native handle is armed before this. */
  beforeInitialSnapshot?: () => void | Promise<void>;
  /** Deterministic test seams for proving one owned polling baseline. */
  snapshotWorkspace?: (root: string) => Promise<string>;
  snapshotSources?: (
    roots: readonly string[],
    observations: readonly WorkflowSourceObservation[],
  ) => Promise<ReadonlyMap<string, string>>;
}

export interface SharedWorkspaceWatchBrokerOptions extends WorkspaceWatchOptions {
  /** Fresh process-local proof expires when the final continuous lease ends. */
  onLastLeaseReleased?: (canonicalRoot: string) => void;
}

export interface SharedWorkspaceWatchSubscriber extends WorkspaceWatchCallbacks {
  root: string;
}

export interface SharedWorkspaceWatchBrokerLike {
  subscribe(
    key: object,
    subscriber: SharedWorkspaceWatchSubscriber,
  ): Promise<void>;
  unsubscribe(key: object): void;
}

export class WorkspaceRootWatcher {
  private watcher: WorkspaceWatchHandle | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sourceTimer: ReturnType<typeof setTimeout> | null = null;
  private sourceRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private inventoryTimer: ReturnType<typeof setTimeout> | null = null;
  private inventoryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private sourcePaths = new Set<string>();
  private ambiguousSourceChange = false;
  private lastSourceSnapshots: ReadonlyMap<string, string> | null = null;
  private lastSourceRequest: SourceSnapshotRequest | null = null;
  private lastInventorySnapshot: string | null;
  private failedInventorySnapshot: string | null = null;
  private inventoryGeneration = 0;
  private inventoryCheckInFlight = false;
  private inventoryCheckPending = false;
  private inventoryReconcilePending = false;
  private pollInFlight = false;
  private initialized = false;
  private polling = false;
  private callbackQueue: Promise<void> = Promise.resolve();
  private rawGeneration = 0;
  private sourceGeneration = 0;

  private constructor(
    readonly root: string,
    private readonly callbacks: WorkspaceWatchCallbacks,
    private readonly options: WorkspaceWatchOptions,
  ) {
    this.lastInventorySnapshot = null;
    this.arm();
  }

  static begin(
    root: string,
    callbacks: WorkspaceWatchCallbacks,
    options: WorkspaceWatchOptions,
  ): { watcher: WorkspaceRootWatcher; ready: Promise<void> } {
    // Arm before reading the async baseline. A generation change during that
    // walk forces a reconciliation callback plus a trailing fingerprint pass.
    const watcher = new WorkspaceRootWatcher(root, callbacks, options);
    return { watcher, ready: watcher.initialize() };
  }

  private async initialize(): Promise<void> {
    const generation = this.rawGeneration;
    await this.options.beforeInitialSnapshot?.();
    if (this.closed) return;
    const [initialInventorySnapshot, initialSourceSample] = await Promise.all([
      this.snapshotWorkspace(this.root),
      this.sampleSourceSnapshots(),
    ]);
    if (this.closed) return;
    if (this.lastInventorySnapshot === null) {
      this.lastInventorySnapshot = initialInventorySnapshot;
    } else if (this.lastInventorySnapshot !== initialInventorySnapshot) {
      this.checkInventoryAsync();
    }
    if (this.sourceSampleIsCurrent(initialSourceSample)) {
      if (
        initialSourceSample.baselineSnapshots !== null &&
        initialSourceSample.changedRoots.length > 0
      ) {
        this.scheduleSourceChange(null);
      } else {
        this.acceptSourceSample(initialSourceSample);
      }
    }
    if (generation !== this.rawGeneration) {
      this.checkInventoryAsync();
    }
    this.initialized = true;
    if (this.polling) {
      // Polling has no raw event protecting the baseline walk. Reconcile once
      // from the baseline we just accepted, without launching a competing
      // second workspace/source walk. This covers an edit that landed between
      // watcher setup and the first sample while retaining a single owner for
      // startup I/O.
      try {
        this.callbacks.onPotentialChange?.(null);
      } catch {
        // The source callback below still performs the bounded reconciliation.
      }
      const retainedRoots = [...initialSourceSample.snapshots.keys()].sort();
      this.sourceGeneration += 1;
      // An empty concrete list still asks every production subscriber to scan
      // its containing workspace. Avoid null here: null intentionally performs
      // a fresh source snapshot to attribute an ambiguous runtime event, which
      // would reintroduce the duplicate startup walk this path eliminates.
      this.dispatchSourceChange(retainedRoots, this.sourceGeneration);
    }
  }

  private snapshotWorkspace(root: string): Promise<string> {
    return (this.options.snapshotWorkspace ?? snapshotWorkspaceWorkflowsAsync)(
      root,
    );
  }

  private snapshotSources(
    roots: readonly string[],
    observations: readonly WorkflowSourceObservation[],
  ): Promise<ReadonlyMap<string, string>> {
    return (this.options.snapshotSources ?? snapshotWorkflowSourceRootsAsync)(
      roots,
      observations,
    );
  }

  private readSourceSnapshotRequest(): SourceSnapshotRequest {
    try {
      return sourceSnapshotRequest(
        this.callbacks.listSourceRoots(),
        this.callbacks.listSourceObservations?.() ?? [],
      );
    } catch {
      // Source declarations are hints. A transient reader failure cannot erase
      // accepted coverage or manufacture a source delta; the next sample
      // retries while workspace inventory polling remains independent.
      return this.lastSourceRequest ?? sourceSnapshotRequest([], []);
    }
  }

  private async sampleSourceSnapshots(): Promise<SourceSnapshotSample> {
    const request = this.readSourceSnapshotRequest();
    const baselineRequest = this.lastSourceRequest;
    const baselineSnapshots = this.lastSourceSnapshots;
    if (
      baselineRequest &&
      baselineSnapshots &&
      baselineRequest.signature !== request.signature
    ) {
      // Observation membership is consumer-owned configuration, not a
      // filesystem mutation. Compare like-for-like against the accepted
      // declaration first so a caller/subscriber retirement cannot manufacture
      // a discovery edit. Sample the current declaration before the comparable
      // old declaration: a common-coverage edit between those walks is then
      // reported by the old comparison, while a later edit remains visible
      // against the earlier current-declaration baseline on the next sample.
      const snapshots = await this.snapshotSources(
        request.roots,
        request.observations,
      );
      const comparableSnapshots = await this.snapshotSources(
        baselineRequest.roots,
        baselineRequest.observations,
      );
      return {
        request,
        snapshots,
        changedRoots: changedSourceRoots(
          baselineSnapshots,
          comparableSnapshots,
        ),
        baselineRequest,
        baselineSnapshots,
      };
    }
    const snapshots = await this.snapshotSources(
      request.roots,
      request.observations,
    );
    return {
      request,
      snapshots,
      changedRoots: baselineSnapshots
        ? changedSourceRoots(baselineSnapshots, snapshots)
        : [],
      baselineRequest,
      baselineSnapshots,
    };
  }

  private sourceSampleIsCurrent(sample: SourceSnapshotSample): boolean {
    return (
      this.lastSourceRequest === sample.baselineRequest &&
      this.lastSourceSnapshots === sample.baselineSnapshots
    );
  }

  private acceptSourceSample(sample: SourceSnapshotSample): boolean {
    if (!this.sourceSampleIsCurrent(sample)) return false;
    this.lastSourceRequest = sample.request;
    this.lastSourceSnapshots = sample.snapshots;
    return true;
  }

  private enqueue(
    callback: () => void | Promise<void>,
    onFailure?: () => void,
  ): void {
    this.callbackQueue = this.callbackQueue.then(async () => {
      if (this.closed) return;
      try {
        await callback();
      } catch {
        // Watch callbacks are refresh hints. A failed scan/build must not tear
        // down the watcher or affect the rest of Studio.
        try {
          onFailure?.();
        } catch {
          // Failure recovery is best-effort too.
        }
      }
    });
  }

  private enqueueSource(
    callback: () => void | Promise<void>,
    onFailure: () => void,
  ): void {
    // Source generations intentionally overlap. A raw edit arriving while an
    // accepted scan is held must reach the coordinator immediately so it can
    // supersede that flight and run one trailing pass; serializing behind the
    // older callback would publish the stale pass and then start a third scan.
    void Promise.resolve()
      .then(async () => {
        if (this.closed) return;
        await callback();
      })
      .catch(() => {
        if (this.closed) return;
        try {
          onFailure();
        } catch {
          // Failure recovery remains best-effort.
        }
      });
  }

  private scheduleSourceChange(sourcePath: string | null): void {
    if (this.closed) return;
    if (sourcePath === null) this.ambiguousSourceChange = true;
    else this.sourcePaths.add(sourcePath);
    if (this.sourceTimer) clearTimeout(this.sourceTimer);
    if (this.sourceRetryTimer) clearTimeout(this.sourceRetryTimer);
    this.sourceRetryTimer = null;
    this.sourceTimer = setTimeout(() => {
      this.sourceTimer = null;
      const paths = this.ambiguousSourceChange
        ? null
        : [...this.sourcePaths].sort();
      this.sourcePaths.clear();
      this.ambiguousSourceChange = false;
      this.sourceGeneration += 1;
      this.dispatchSourceChange(paths, this.sourceGeneration);
    }, this.options.sourceDebounceMs ?? SOURCE_DEBOUNCE_MS);
  }

  private dispatchSourceChange(
    paths: readonly string[] | null,
    generation: number,
    retry = 0,
  ): void {
    this.enqueueSource(
      async () => {
        if (generation !== this.sourceGeneration) return;
        let effectivePaths = paths;
        let sourceSample: SourceSnapshotSample | null = null;
        if (paths === null) {
          sourceSample = await this.sampleSourceSnapshots();
          if (!this.sourceSampleIsCurrent(sourceSample)) {
            // Another accepted sample won the race. The raw event still
            // requires conservative reconciliation, but it must not overwrite
            // that newer baseline when this callback settles.
            effectivePaths = null;
          } else if (sourceSample.baselineSnapshots) {
            effectivePaths =
              sourceSample.changedRoots.length > 0
                ? sourceSample.changedRoots
                : null;
          } else {
            // A raw event raced the initial baseline. The post-edit sample
            // cannot identify a delta, so reconcile every retained root rather
            // than only the parent scope (which may stop at repo/ignore roots).
            const retainedRoots = [...sourceSample.snapshots.keys()].sort();
            effectivePaths = retainedRoots.length > 0 ? retainedRoots : null;
          }
        }
        await this.callbacks.onSourceChange(effectivePaths);
        if (generation !== this.sourceGeneration || this.closed) return;
        if (sourceSample) this.acceptSourceSample(sourceSample);
      },
      () => {
        if (this.closed || generation !== this.sourceGeneration) return;
        if (retry >= (this.options.maxSourceRetries ?? MAX_SOURCE_RETRIES)) {
          // Keep the graph fail-closed after bounded recovery. A later raw
          // event advances sourceGeneration and rearms a fresh retry series;
          // ordinary polling must not become an endless registry-scan loop.
          return;
        }
        const nextRetry = retry + 1;
        const delay = Math.min(
          2_000,
          (this.options.inventoryRetryBaseMs ?? INVENTORY_RETRY_BASE_MS) *
            2 ** Math.min(nextRetry - 1, 3),
        );
        this.sourceRetryTimer = setTimeout(() => {
          this.sourceRetryTimer = null;
          if (this.closed || generation !== this.sourceGeneration) return;
          this.dispatchSourceChange(paths, generation, nextRetry);
        }, delay);
      },
    );
  }

  private dispatchInventoryChange(
    snapshot: string,
    retryNumber = 0,
    retryGeneration?: number,
  ): void {
    const generation = retryGeneration ?? this.inventoryGeneration + 1;
    if (
      retryGeneration !== undefined &&
      retryGeneration !== this.inventoryGeneration
    ) {
      return;
    }
    if (retryGeneration === undefined) {
      this.inventoryGeneration = generation;
      if (this.inventoryRetryTimer) clearTimeout(this.inventoryRetryTimer);
      this.inventoryRetryTimer = null;
    }
    this.lastInventorySnapshot = snapshot;
    this.failedInventorySnapshot = null;
    this.enqueue(
      () => {
        if (generation !== this.inventoryGeneration) return;
        return this.callbacks.onInventoryChange();
      },
      () => {
        if (
          this.closed ||
          generation !== this.inventoryGeneration ||
          this.lastInventorySnapshot !== snapshot
        ) {
          return;
        }
        if (
          retryNumber >=
          (this.options.maxInventoryRetries ?? MAX_INVENTORY_RETRIES)
        ) {
          // Consume the observed fingerprint after bounded recovery. This
          // leaves the server snapshot stale without turning polling into a
          // permanent registry-scan/event-bus loop. A later real source or
          // inventory change clears this sentinel and starts a fresh series.
          this.failedInventorySnapshot = snapshot;
          return;
        }
        this.scheduleInventoryRetry(snapshot, retryNumber + 1, generation);
      },
    );
  }

  private scheduleInventoryRetry(
    snapshot: string,
    retryNumber: number,
    generation: number,
  ): void {
    if (this.closed || generation !== this.inventoryGeneration) return;
    if (this.inventoryRetryTimer) clearTimeout(this.inventoryRetryTimer);
    const delay =
      (this.options.inventoryRetryBaseMs ?? INVENTORY_RETRY_BASE_MS) *
      2 ** (retryNumber - 1);
    this.inventoryRetryTimer = setTimeout(() => {
      this.inventoryRetryTimer = null;
      if (this.closed || generation !== this.inventoryGeneration) return;
      void this.snapshotWorkspace(this.root)
        .then((currentSnapshot) => {
          if (this.closed || generation !== this.inventoryGeneration) return;
          if (currentSnapshot !== snapshot) {
            this.dispatchInventoryChange(currentSnapshot);
            return;
          }
          this.dispatchInventoryChange(snapshot, retryNumber, generation);
        })
        .catch(() => {
          if (this.closed || generation !== this.inventoryGeneration) return;
          this.dispatchInventoryChange(snapshot, retryNumber, generation);
        });
    }, delay);
  }

  private scheduleInventoryCheck(
    delay = this.options.inventoryDebounceMs ?? INVENTORY_DEBOUNCE_MS,
  ): void {
    if (this.closed) return;
    if (this.inventoryTimer) clearTimeout(this.inventoryTimer);
    this.inventoryTimer = setTimeout(() => {
      this.inventoryTimer = null;
      this.checkInventoryAsync();
    }, delay);
  }

  private checkInventoryAsync(): void {
    if (this.closed) return;
    if (this.inventoryCheckInFlight) {
      // One more async pass after the current walk is enough to cover any
      // number of native events that arrive while it yields between dirs.
      this.inventoryCheckPending = true;
      return;
    }
    this.inventoryCheckInFlight = true;
    this.inventoryCheckPending = false;
    void this.snapshotWorkspace(this.root)
      .then((snapshot) => {
        if (this.closed) return;
        const mustReconcile = this.inventoryReconcilePending;
        this.inventoryReconcilePending = false;
        if (
          snapshot === this.lastInventorySnapshot &&
          snapshot !== this.failedInventorySnapshot &&
          !mustReconcile
        ) {
          return;
        }
        this.dispatchInventoryChange(snapshot);
      })
      .catch(() => {
        // A later native event retries an unreadable workspace. Watch hints
        // must never surface as an unhandled rejection or tear down Studio.
      })
      .finally(() => {
        this.inventoryCheckInFlight = false;
        if (this.closed || !this.inventoryCheckPending) return;
        this.inventoryCheckPending = false;
        this.checkInventoryAsync();
      });
  }

  private arm(): void {
    if (this.closed) return;
    if (this.options.forcePolling) {
      this.fallBackToPolling();
      return;
    }
    try {
      const listener = (
        _event: "rename" | "change",
        rawFilename: string | null,
      ): void => {
        if (this.closed) return;
        const potential = (paths: readonly string[] | null): void => {
          this.rawGeneration += 1;
          try {
            this.callbacks.onPotentialChange?.(paths);
          } catch {
            // Raw-event invalidation is best-effort; async reconciliation still
            // runs and reports failures through the normal callback path.
          }
        };
        if (rawFilename === null) {
          potential(null);
          this.scheduleSourceChange(null);
          return;
        }
        const relativePath = normalizeWatchPath(rawFilename);
        if (ignoredRelativePath(relativePath)) return;
        if (sourceRelativePath(relativePath)) {
          const sourcePath = confinedSourcePath(this.root, relativePath);
          potential(sourcePath ? [sourcePath] : null);
          this.scheduleSourceChange(sourcePath);
          // Source reconciliation also scans inventory. Do not enqueue a
          // second serialized inventory callback for the same native edit.
          return;
        }
        const basename = path.posix.basename(relativePath);
        if (basename === "sapiom.json" || basename === "package.json") {
          const sourcePath = confinedSourcePath(this.root, relativePath);
          potential(sourcePath ? [sourcePath] : null);
          this.scheduleSourceChange(sourcePath);
          return;
        }
        if (_event !== "rename") {
          return;
        }
        potential(null);
        this.inventoryReconcilePending = true;
        // Event kind is unreliable across editors/platforms. The marker
        // fingerprint decides whether inventory really changed.
        this.scheduleInventoryCheck();
      };
      this.watcher = this.options.watchFactory
        ? this.options.watchFactory(this.root, listener)
        : fs.watch(this.root, { recursive: true }, (_event, rawFilename) => {
            listener(_event, rawFilename);
          });
      this.watcher.on("error", () => this.fallBackToPolling());
    } catch {
      this.fallBackToPolling();
    }
  }

  private fallBackToPolling(): void {
    if (this.closed || this.pollTimer) return;
    this.polling = true;
    this.watcher?.close();
    this.watcher = null;
    const poll = (): void => {
      if (this.closed || this.pollInFlight || !this.initialized) return;
      this.pollInFlight = true;
      void Promise.all([
        this.sampleSourceSnapshots(),
        this.snapshotWorkspace(this.root),
      ])
        .then(([sourceSample, inventorySnapshot]) => {
          if (this.closed) return;
          const sourceSampleCurrent = this.sourceSampleIsCurrent(sourceSample);
          const changedRoots = sourceSampleCurrent
            ? sourceSample.changedRoots
            : [];
          const inventoryChanged =
            this.lastInventorySnapshot !== null &&
            inventorySnapshot !== this.lastInventorySnapshot;
          if (sourceSampleCurrent) this.acceptSourceSample(sourceSample);
          let sourceChanged = false;
          if (inventoryChanged) {
            // Structural evidence wins when both bounded channels move. A
            // newly-created `candidate/.git` also changes that candidate's
            // directory/source fingerprint; direct-scanning it would turn the
            // foreign repository into an accidental explicit selection.
            try {
              this.callbacks.onPotentialChange?.(null);
            } catch {
              // Reconciliation still follows below.
            }
            this.dispatchInventoryChange(inventorySnapshot);
          } else if (changedRoots.length > 0) {
            sourceChanged = true;
            try {
              this.callbacks.onPotentialChange?.(changedRoots);
            } catch {
              // The queued callbacks still reconcile the observed delta.
            }
            for (const sourceRoot of changedRoots) {
              this.scheduleSourceChange(sourceRoot);
            }
          }

          if (this.lastInventorySnapshot === null) {
            this.lastInventorySnapshot = inventorySnapshot;
          } else if (
            sourceChanged &&
            inventorySnapshot === this.failedInventorySnapshot
          ) {
            // Polling has no raw filesystem event. A source-fingerprint change
            // is its proof that a real edit occurred after bounded give-up.
            this.dispatchInventoryChange(inventorySnapshot);
          }
        })
        .catch(() => {
          // The next poll retries an unreadable workspace.
        })
        .finally(() => {
          this.pollInFlight = false;
        });
    };
    // Constructor-time fallback is intentionally quiet: initialize() owns the
    // first source + inventory baseline and its conservative reconciliation.
    // A runtime native-watch failure occurs after initialization and therefore
    // performs an immediate recovery poll.
    if (this.initialized) poll();
    this.pollTimer = setInterval(
      poll,
      this.options.pollIntervalMs ?? POLL_INTERVAL_MS,
    );
  }

  close(): void {
    this.closed = true;
    if (this.sourceTimer) clearTimeout(this.sourceTimer);
    if (this.sourceRetryTimer) clearTimeout(this.sourceRetryTimer);
    if (this.inventoryTimer) clearTimeout(this.inventoryTimer);
    if (this.inventoryRetryTimer) clearTimeout(this.inventoryRetryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    this.watcher = null;
  }
}

interface SharedWorkspaceWatchLease {
  canonicalRoot: string;
  subscribers: Map<object, SharedWorkspaceWatchSubscriber>;
  watcher: WorkspaceRootWatcher;
  ready: Promise<void>;
}

/**
 * Process-wide watcher/fingerprint lease keyed by canonical workspace root.
 * Session and graph consumers share one native handle, one polling baseline,
 * and one bounded metadata traversal; callbacks fan out only after that shared
 * observation has been accepted.
 */
export class SharedWorkspaceWatchBroker implements SharedWorkspaceWatchBrokerLike {
  private readonly leases = new Map<string, SharedWorkspaceWatchLease>();
  private readonly rootBySubscriber = new Map<object, string>();

  constructor(
    private readonly options: SharedWorkspaceWatchBrokerOptions = {},
  ) {}

  subscribe(
    key: object,
    subscriber: SharedWorkspaceWatchSubscriber,
  ): Promise<void> {
    const canonicalRoot = canonicalGraphPath(subscriber.root);
    const previousRoot = this.rootBySubscriber.get(key);
    if (previousRoot && previousRoot !== canonicalRoot) this.unsubscribe(key);

    const existing = this.leases.get(canonicalRoot);
    if (existing) {
      existing.subscribers.set(key, subscriber);
      this.rootBySubscriber.set(key, canonicalRoot);
      return existing.ready;
    }

    const subscribers = new Map([[key, subscriber]]);
    const currentSubscribers = (): SharedWorkspaceWatchSubscriber[] => [
      ...subscribers.values(),
    ];
    const started = WorkspaceRootWatcher.begin(
      canonicalRoot,
      {
        listSourceRoots: () => {
          const roots = new Set<string>();
          for (const current of currentSubscribers()) {
            try {
              for (const root of current.listSourceRoots()) roots.add(root);
            } catch {
              // Another subscriber can still supply a useful baseline.
            }
          }
          return [...roots].sort();
        },
        listSourceObservations: () => {
          const observations: WorkflowSourceObservation[] = [];
          const seen = new Set<string>();
          for (const current of currentSubscribers()) {
            let listed: readonly WorkflowSourceObservation[] = [];
            try {
              listed = current.listSourceObservations?.() ?? [];
            } catch {
              continue;
            }
            for (const observation of listed) {
              const fingerprint = JSON.stringify([
                observation.workspaceRoot,
                observation.candidateRoot,
                [...observation.paths].sort(),
              ]);
              if (seen.has(fingerprint)) continue;
              seen.add(fingerprint);
              observations.push(observation);
            }
          }
          return observations;
        },
        onPotentialChange: (paths) => {
          for (const current of currentSubscribers()) {
            try {
              current.onPotentialChange?.(paths);
            } catch {
              // One fail-close consumer must not suppress the others.
            }
          }
        },
        onSourceChange: async (paths) => {
          const results = await Promise.allSettled(
            currentSubscribers().map((current) =>
              Promise.resolve().then(() => current.onSourceChange(paths)),
            ),
          );
          const failed = results.find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          );
          if (failed) throw failed.reason;
        },
        onInventoryChange: async () => {
          const results = await Promise.allSettled(
            currentSubscribers().map((current) =>
              Promise.resolve().then(() => current.onInventoryChange()),
            ),
          );
          const failed = results.find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          );
          if (failed) throw failed.reason;
        },
      },
      this.options,
    );
    const lease: SharedWorkspaceWatchLease = {
      canonicalRoot,
      subscribers,
      watcher: started.watcher,
      ready: Promise.resolve(),
    };
    lease.ready = started.ready.catch((error: unknown) => {
      started.watcher.close();
      if (this.leases.get(canonicalRoot) === lease) {
        this.leases.delete(canonicalRoot);
        for (const subscriberKey of subscribers.keys()) {
          if (this.rootBySubscriber.get(subscriberKey) === canonicalRoot) {
            this.rootBySubscriber.delete(subscriberKey);
          }
        }
      }
      throw error;
    });
    this.leases.set(canonicalRoot, lease);
    this.rootBySubscriber.set(key, canonicalRoot);
    return lease.ready;
  }

  unsubscribe(key: object): void {
    const canonicalRoot = this.rootBySubscriber.get(key);
    if (!canonicalRoot) return;
    this.rootBySubscriber.delete(key);
    const lease = this.leases.get(canonicalRoot);
    if (!lease) return;
    lease.subscribers.delete(key);
    if (lease.subscribers.size > 0) return;
    lease.watcher.close();
    this.leases.delete(canonicalRoot);
    try {
      this.options.onLastLeaseReleased?.(canonicalRoot);
    } catch {
      // Lease retirement must always close the underlying OS resource.
    }
  }

  get size(): number {
    return this.leases.size;
  }
}
