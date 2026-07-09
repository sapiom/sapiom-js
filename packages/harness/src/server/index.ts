/**
 * Harness server — integration point for every workstream.
 *
 * Single process: serves the built SPA from dist/web, the REST surface, the
 * webhook ingest endpoint, canvas file serving, and the two WebSocket
 * endpoints (/ws/terminal, /ws/events). Binds 127.0.0.1 only. See
 * src/shared/types.ts for the full protocol contract.
 */

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { WebSocketServer } from "ws";
import open from "open";

import type {
  AnalyticsEvent,
  AppState,
  HarnessAdapter,
  HarnessKind,
  HarnessSession,
  WorkflowInfo,
} from "../shared/types.js";
import { resolveStatePaths } from "../core/paths.js";
import { seedExampleProject } from "../core/example-seed.js";
import { SessionManager, type LaunchOptsBuilder } from "../core/session-manager.js";
import { TaskManager } from "../core/task-manager.js";
import { createClaudeCodeAdapter } from "../core/adapters/claude-code.js";
import { createCodexAdapter } from "../core/adapters/codex.js";
import { WorkflowRegistry, createWorkflowsRouter } from "../core/workflow-registry.js";
import { DEFAULT_MACROS } from "../core/macros.js";
import { createEventStore } from "../core/collector/store.js";
import { createHarnessEmitter } from "../core/collector/analytics-emitter.js";
import { migrateHarnessIdentity } from "../core/collector/identity-migration.js";
import { normalizeHookEvent } from "../core/collector/normalizer.js";
import { enrichTurnCompleted } from "../core/collector/transcript.js";
import { createSeqCounter } from "../core/collector/seq.js";
import { findRolloutFile, tailCodexRollout, type CodexTailerHandle } from "../core/collector/codex-tailer.js";
import { getOrCreateMachineId } from "../cli/machine-id.js";
import { pruneDeadRecentDirs } from "../cli/settings.js";
import type { HarnessIdentity } from "../cli/auth.js";
import { generateClaudeSettings } from "../core/inject/claude-settings.js";
import { generateMcpConfig } from "../core/inject/mcp-config.js";
import { generateSystemPromptFile } from "../core/inject/system-prompt.js";
import { removeGeneratedSessionDir, sweepGeneratedDirs } from "../core/inject/retention.js";
import { CanvasWatcherManager } from "../core/canvas-watcher.js";
import { WorkspaceWatcherManager } from "../core/workspace-watcher.js";
import { PortDetector, portFromUrl } from "../core/port-detector.js";
import { EventBus } from "../core/event-bus.js";
import { writeHarnessContext, harnessContextFileExists } from "../core/workspace-context.js";
import { ensureCanvasTemplate } from "../core/canvas-template.js";
import { renderCanvasForSession, renderWorkflowRenderFile } from "../core/canvas-render.js";
import { CanvasEnrichmentCoordinator } from "../core/canvas-enrich.js";
import { sweepNdjson } from "../core/collector/store-retention.js";
import { createBootTokenMiddleware } from "./auth.js";
import { createRestRouter } from "./rest.js";
import { createStaticRouter } from "./static.js";
import { createTerminalWebSocketHandler } from "./terminal-ws.js";
import { createEventsWebSocketHandler } from "./events-ws.js";
import { attachWebSocketRouters } from "./ws-router.js";
import { createIngestRouter, processIngest, type IngestDeps, type IngestRequestBody, type IngestSessionContext } from "./ingest.js";
import { createCanvasRouter } from "./canvas.js";
import { createCanvasRenderRouter } from "./canvas-render.js";
import { createMacrosRouter } from "./macros.js";
import { createFsRouter } from "./fs.js";

/**
 * Codex has no hook system — its rollout file is polled into existence
 * (findRolloutFile) rather than announced, so discovery needs a bounded
 * retry loop rather than a single lookup. 15s covers a slow process spawn
 * with margin; if Codex still hasn't written a rollout file by then,
 * something's wrong enough that surfacing an error beats waiting longer.
 */
const CODEX_ROLLOUT_DISCOVERY_TIMEOUT_MS = 15_000;
const CODEX_ROLLOUT_DISCOVERY_POLL_MS = 300;

/** Workflow list is refreshed off this interval for the (synchronous)
 * macro-resolution lookup — connect/scan are infrequent user actions, so a
 * few seconds of staleness there is an acceptable tradeoff for not having to
 * thread an async registry lookup through the macro-runner's sync contract. */
const WORKFLOWS_CACHE_REFRESH_MS = 3_000;

/** How often SessionManager.sweepDeadSessions() runs — the backstop that
 * reconciles any non-exited session record whose pty process is actually
 * gone (node-pty's occasionally-missed onExit, or a transition nothing else
 * reconciled), so a ghost tab self-heals within seconds instead of sitting
 * in the tab strip until the server restarts. The sweep is a cheap in-memory
 * walk plus a signal-0 probe per live pty. */
const SESSION_LIVENESS_SWEEP_MS = 10_000;

/** events.ndjson retention: sweeps once at boot and then periodically.
 * Keeps the local sink from growing unbounded on long-lived installs. */
const NDJSON_RETENTION_SWEEP_MS = 6 * 60 * 60 * 1_000; // every 6 hours

export interface HarnessServerOptions {
  port: number;
  /** Bind address. Defaults to 127.0.0.1 — the server must never listen on 0.0.0.0. */
  host?: string;
  /** Per-boot secret; required on WS upgrades, /api (header) and hook scripts (bearer). */
  bootToken: string;
  telemetryOptIn: boolean;
  /** Sapiom identity from CLI auth; omit/null when unauthenticated or --no-auth. */
  identity?: HarnessIdentity | null;
  /** Stable per-install id for analytics. Defaults to a freshly loaded/created one. */
  machineId?: string;
  /** Override the adapter set (tests inject a stubbed claude-code binary). */
  adapters?: Partial<Record<HarnessKind, HarnessAdapter>>;
  /** Root directory ALL persistent harness state lives under: machine-id,
   *  sessions.json, workflows.json, events.ndjson, settings.json, generated/
   *  and sample-project/. Defaults to the real HARNESS_HOME
   *  (`~/.sapiom/harness`) — unchanged for CLI users. Tests, e2e scripts and
   *  live checks MUST pass a scratch directory here so a server boot never
   *  registers its temp projects (or anything else) into the developer's
   *  real state. The per-file options below still override individual
   *  locations; each now defaults under this root. */
  stateRoot?: string;
  /** Session registry file. Defaults to `<stateRoot>/sessions.json`. */
  sessionsPath?: string;
  buildLaunchOpts?: LaunchOptsBuilder;
  /** Root directory per-session generated agent configs are written under —
   *  and cleaned up from (exit-time delete + boot-time sweep, see
   *  core/inject/retention.ts). Defaults to `<stateRoot>/generated`. */
  generatedRoot?: string;
  collectorUrl?: string;
  /** Workflow registry file. Defaults to `<stateRoot>/workflows.json`. */
  workflowsRegistryPath?: string;
  /** Local analytics ndjson sink. Defaults to `<stateRoot>/events.ndjson`. */
  eventStorePath?: string;
  /** Overrides the home directory codex rollout discovery scans
   * (`<home>/.codex/sessions/...`). Defaults to the real OS home dir; tests
   * point this at a fixture tree instead of touching `~/.codex` for real. */
  codexHomeDir?: string;
  /** Directory the built SPA lives in. Defaults to dist/web next to this module. */
  webDir?: string;
  /** The directory the CLI was launched against — scanned for workflows at
   *  boot so the rail isn't empty until a manual "+ Connect", and (unless
   *  autoCreateSession is false) where the boot session is created. */
  launchDir?: string;
  /** Auto-create a session in launchDir once the server is listening, so the
   *  app doesn't open empty. Defaults to true; the CLI's --no-session flag
   *  sets this to false. Uses `defaultHarnessKind` for which agent to launch. */
  autoCreateSession?: boolean;
  /** Harness kind for the auto-created boot session. The CLI resolves this
   *  from doctor() results (claude-code if present, else codex) before
   *  calling startServer; defaults to "claude-code" for callers that don't
   *  run doctor (tests, --dev flows without a real agent). */
  defaultHarnessKind?: HarnessKind;
  /** Harness kinds confirmed available at CLI boot (doctor()), surfaced
   *  as-is in AppState for the SPA — see its doc comment. Omitted (not
   *  defaulted here) when the caller doesn't supply it. */
  availableHarnesses?: HarnessKind[];
  /** "This boot found no prior harness use on this machine" — computed by
   *  the CLI before it records the launch dir, surfaced verbatim in
   *  AppState.firstRun (see its doc comment). Omitted → absent there too. */
  firstRun?: boolean;
  /**
   * How telemetry consent was determined — passed through verbatim into
   * AppState.consentSource. Omitted when the caller didn't run the consent
   * flow (tests, mocks).
   */
  consentSource?: AppState["consentSource"];
  /**
   * Which env var forced telemetry off (when consentSource === "env-forced-off").
   * Passed through into AppState.consentEnvReason.
   */
  consentEnvReason?: string | null;
  /** Where POST /api/sample-project seeds the bundled example. Defaults to
   *  `<stateRoot>/sample-project`. */
  sampleProjectRoot?: string;
}

export interface HarnessServer {
  close(): Promise<void>;
  port: number;
  sessionManager: SessionManager;
}

// This module lives at either src/server/index.ts (tsx dev) or
// dist/server/index.js (built) — both are two directories below the package
// root, so this resolves correctly either way.
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Whether two workflow lists are equivalent for the rail's purposes —
 *  compares the fields the SPA actually renders/keys on, order-insensitive, so
 *  a rescan that turned up nothing new doesn't trigger a needless broadcast. */
function workflowListsEqual(a: readonly WorkflowInfo[], b: readonly WorkflowInfo[]): boolean {
  if (a.length !== b.length) return false;
  const key = (w: WorkflowInfo): string => `${w.path} ${w.name} ${w.definitionId ?? ""} ${w.source}`;
  const setA = new Set(a.map(key));
  return b.every((w) => setA.has(key(w)));
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Real launch-opts wiring: generates the per-session --settings, --mcp-config,
 * and --append-system-prompt source files. Generated uniformly for every
 * harness kind — an adapter that doesn't use one of these fields (codex,
 * today) simply ignores it, same as the claude-code adapter already does for
 * whichever of the three a given launch doesn't set. `apiKey` (from CLI auth,
 * null when unauthenticated / --no-auth) flows into the generated mcp-config
 * so the remote `sapiom` MCP is actually authenticated — a factory rather
 * than a plain function since it's per-server-instance state.
 */
function createDefaultBuildLaunchOpts(apiKey: string | null, generatedRoot?: string): LaunchOptsBuilder {
  return async (harnessSessionId) => {
    const [settings, mcpConfigFile, systemPromptFile] = await Promise.all([
      generateClaudeSettings({ harnessSessionId, generatedRoot }),
      generateMcpConfig(harnessSessionId, { environment: process.env.SAPIOM_ENVIRONMENT, apiKey, generatedRoot }),
      generateSystemPromptFile(harnessSessionId, { generatedRoot }),
    ]);
    return {
      settingsFile: settings.settingsPath,
      mcpConfigFile,
      systemPromptFile,
    };
  };
}

export const startServer = async (options: HarnessServerOptions): Promise<HarnessServer> => {
  const host = options.host ?? "127.0.0.1";
  const identity = options.identity ?? null;
  const statePaths = resolveStatePaths(options.stateRoot);
  const machineId = options.machineId ?? (await getOrCreateMachineId(statePaths.machineId));

  // One-way identity migration: seed ~/.sapiom/analytics.json from the
  // legacy harness machine-id so existing installs keep the same anonymous_id
  // after the upgrade (longitudinal join key survives). No-op when analytics.json
  // already exists or when HOME is unwritable.
  await migrateHarnessIdentity(statePaths.machineId);
  const launchDir = options.launchDir ?? process.cwd();
  const adapters: Partial<Record<HarnessKind, HarnessAdapter>> =
    options.adapters ??
    ({
      "claude-code": createClaudeCodeAdapter(),
      codex: createCodexAdapter(),
    } satisfies Partial<Record<HarnessKind, HarnessAdapter>>);

  const bus = new EventBus();
  const canvasWatcher = new CanvasWatcherManager({
    onChange: (harnessSessionId) => bus.publish({ type: "canvas.reload", harnessSessionId }),
  });
  // The harness's own infrastructure shouldn't ever show up as a "discovered"
  // dev server in the Preview pane — a mention of our own listening port (in
  // an agent's own output, e.g. echoing SAPIOM_HARNESS_INGEST_URL) or the
  // analytics collector's port is not something the user started. `options
  // .port` covers the common case (bin.ts always passes a concrete port);
  // the actual bound port is added below once listen() resolves, covering
  // the ephemeral `port: 0` case tests use. (There's no separate "vite dev
  // port" to exclude beyond this — in dev mode the harness's own listening
  // port *is* what `web/vite.config.ts`'s proxy targets, so excluding it
  // here already covers that pairing.)
  const excludedPorts = new Set<number>();
  if (options.port) excludedPorts.add(options.port);
  if (options.collectorUrl) {
    const collectorPort = portFromUrl(options.collectorUrl);
    if (collectorPort !== null) excludedPorts.add(collectorPort);
  }
  const portDetector = new PortDetector({
    onPort: (harnessSessionId, port, url) => bus.publish({ type: "port.detected", harnessSessionId, port, url }),
    excludedPorts,
  });

  // Declared before sessionManager: writeSessionContext (sessionManager's
  // writeWorkspaceContext option) needs workflowsCache in scope to resolve a
  // session's boundWorkflowPath into a full WorkflowInfo. scanWorkflowsAndBroadcast
  // stays defined below sessionManager instead, since it needs sessionManager
  // itself (to rewrite every open session's context file on a registry change) —
  // no circularity, since only writeSessionContext is threaded into SessionManager's
  // constructor, and it doesn't need sessionManager.
  const workflowRegistry = new WorkflowRegistry(options.workflowsRegistryPath ?? statePaths.workflows);
  // Boot-time hygiene, before the first list(): drop registry entries whose
  // path no longer exists on disk (deleted projects, temp dirs a crashed run
  // left registered) so the rail — and every harness-context.json written
  // below — never resurrects a dead project. Deliberately awaited: nothing
  // downstream should ever observe the pre-prune list.
  try {
    const prunedWorkflows = await workflowRegistry.prune();
    for (const workflow of prunedWorkflows) {
      console.error(`[harness] pruned workflow registry entry with missing path: ${workflow.path}`);
    }
  } catch (err) {
    console.error("[harness] workflow registry prune failed:", err);
  }
  // Same hygiene for settings.json's recentDirs — dead entries are already
  // filtered from every read, but pruning here persists their removal.
  // Awaited so it can't race a settings PATCH once the server is listening.
  try {
    for (const dir of await pruneDeadRecentDirs(statePaths.settings)) {
      console.error(`[harness] pruned recent dir with missing path: ${dir}`);
    }
  } catch (err) {
    console.error("[harness] recent-dirs prune failed:", err);
  }
  let workflowsCache: WorkflowInfo[] = await workflowRegistry.list();
  const workflowsCacheTimer = setInterval(() => {
    void workflowRegistry.list().then((list) => {
      workflowsCache = list;
    });
  }, WORKFLOWS_CACHE_REFRESH_MS);
  workflowsCacheTimer.unref?.();

  /**
   * Writes HARNESS_CONTEXT_FILE for a single session, resolving its
   * `boundWorkflowPath` against the live registry so the file always
   * reflects the session's actual current binding (not just what a caller
   * happened to have on hand) — and the full `workflows` list, so an agent
   * can answer "what workflows exist" without a UI round-trip. Shared by
   * SessionManager's create()/resume(), the PATCH bind/unbind route, and
   * scanWorkflowsAndBroadcast's rewrite-all-open-sessions step below.
   */
  const writeSessionContext = async (session: HarnessSession): Promise<void> => {
    const boundWorkflow = session.boundWorkflowPath
      ? (workflowsCache.find((w) => w.path === session.boundWorkflowPath) ?? null)
      : null;
    await writeHarnessContext(session, boundWorkflow, workflowsCache);
  };

  // Exit-time deletion of generated/<id> (see the onStatusChange handler
  // below) can race a fast resume(): resume regenerates the dir via
  // buildLaunchOpts, and the rm scheduled at the previous exit could still
  // be in flight. Serialize by awaiting any pending removal for this id
  // before (re)generating its files.
  const generatedRoot = options.generatedRoot ?? statePaths.generated;
  const pendingGeneratedRemovals = new Map<string, Promise<void>>();
  const innerBuildLaunchOpts =
    options.buildLaunchOpts ?? createDefaultBuildLaunchOpts(identity?.apiKey ?? null, generatedRoot);
  const buildLaunchOpts: LaunchOptsBuilder = async (harnessSessionId, req) => {
    await pendingGeneratedRemovals.get(harnessSessionId);
    return innerBuildLaunchOpts(harnessSessionId, req);
  };

  const sessionManager = new SessionManager({
    adapters,
    ingestUrl: `http://${host}:${options.port}`,
    ingestToken: options.bootToken,
    collectorUrl: options.collectorUrl,
    sessionsPath: options.sessionsPath ?? statePaths.sessions,
    buildLaunchOpts,
    // Every session gets its initial harness-context.json regardless of
    // entry point (REST, autoCreateSession) — see SessionManager.create().
    writeWorkspaceContext: writeSessionContext,
    workspaceContextExists: (cwd) => harnessContextFileExists(cwd),
    ensureCanvasTemplate,
  });
  await sessionManager.init();

  const sessionSweepTimer = setInterval(() => sessionManager.sweepDeadSessions(), SESSION_LIVENESS_SWEEP_MS);
  sessionSweepTimer.unref?.();

  // Background tasks (canvas enrichment today): headless one-shot agent
  // runs that never touch a user's interactive session. They
  // reuse the exact same per-id config generation as sessions — a task's
  // generated/<taskId> dir gets the same exit-time removal below, and (via
  // sweepGeneratedDirs above; a task id is never a live session id, so the
  // liveness guard passes it through) the same age-gated crash sweep.
  const taskManager = new TaskManager({
    adapters,
    ingestUrl: `http://${host}:${options.port}`,
    ingestToken: options.bootToken,
    collectorUrl: options.collectorUrl,
    buildLaunchOpts,
    onCleanup: (taskId) => {
      void removeGeneratedSessionDir(taskId, { generatedRoot }).catch((err: unknown) => {
        console.error("[harness] task generated-dir cleanup failed:", err);
      });
    },
  });
  taskManager.onStatusChange((task) => {
    bus.publish({ type: "task.status", task });
  });

  // One boot-time sweep for generated dirs the exit-time cleanup below never
  // reached (crashes, force-kills, accumulation from before retention
  // existed). Age-gated (GENERATED_SWEEP_MAX_AGE_MS) and skips live
  // sessions' dirs — fire-and-forget, boot must not wait on potentially
  // thousands of removals.
  void sweepGeneratedDirs({
    generatedRoot,
    isLiveSession: (harnessSessionId) => {
      const session = sessionManager.get(harnessSessionId);
      return session !== undefined && session.status !== "exited";
    },
  }).catch((err: unknown) => {
    console.error("[harness] generated-dir sweep failed:", err);
  });

  // Rail freshness: a session's workflow set can change mid-session — the
  // agent scaffolds a new workflow directory, or one gets deleted — and the
  // rail must keep up rather than stay frozen at whatever the boot/session-
  // create scan found. On a (debounced) structural change under a session's
  // workspace, prune dead paths, re-scan its cwd, and — only when the workflow
  // list actually changed — rewrite every open session's context file and
  // broadcast `workflows.changed` (the SPA refetches /api/workflows on it).
  // Pruning here is what lets a deleted workflow drop out (a plain scan only
  // ever merges in); it respects the same ENOENT/ENOTDIR-only guard as the
  // boot prune, so a merely-unbuilt or unreadable project stays put.
  const rescanWorkspaceForSession = async (harnessSessionId: string): Promise<void> => {
    const session = sessionManager.get(harnessSessionId);
    if (!session || session.status === "exited") return;
    const before = workflowsCache;
    await workflowRegistry.prune();
    await workflowRegistry.scan(session.cwd);
    const after = await workflowRegistry.list();
    workflowsCache = after;
    if (workflowListsEqual(before, after)) return;
    await Promise.all(sessionManager.list().map((s) => writeSessionContext(s)));
    bus.publish({ type: "workflows.changed" });
  };
  const workspaceWatcher = new WorkspaceWatcherManager({
    onChange: (harnessSessionId) => {
      rescanWorkspaceForSession(harnessSessionId).catch((err: unknown) => {
        console.error("[harness] workspace rescan failed:", err);
      });
    },
  });

  sessionManager.onStatusChange((session) => {
    bus.publish({ type: "session.status", session });
    if (session.status === "running") {
      canvasWatcher.start(session.id, session.cwd);
      workspaceWatcher.start(session.id, session.cwd);
    } else if (session.status === "exited") {
      canvasWatcher.stop(session.id);
      workspaceWatcher.stop(session.id);
      portDetector.reset(session.id);
      // The generated config dir is dead once the pty is: every file in it
      // is regenerated by buildLaunchOpts on resume, and the agent's last
      // emit.cjs execution (SessionEnd) happens before its process exits.
      const removal = removeGeneratedSessionDir(session.id, { generatedRoot })
        .then(() => undefined)
        .catch((err: unknown) => {
          console.error("[harness] generated-dir cleanup failed:", err);
        })
        .finally(() => {
          if (pendingGeneratedRemovals.get(session.id) === removal) {
            pendingGeneratedRemovals.delete(session.id);
          }
        });
      pendingGeneratedRemovals.set(session.id, removal);
    }
  });

  // Background sessions have no /ws/terminal socket open to stream bytes over
  // (only the active tab does) — this is the lightweight substitute that lets
  // every session's tab show a busy pulse regardless of which one is active.
  sessionManager.onActivity((harnessSessionId) => {
    bus.publish({ type: "session.activity", harnessSessionId, at: new Date().toISOString() });
  });

  // Nothing else triggers a scan (the only other entry point is the SPA's
  // manual "+ Connect"), so the rail would otherwise stay empty until a user
  // does that by hand. Scan the CLI's launch directory once at boot, and
  // again whenever a session opens in a (possibly different) directory —
  // and let anyone already looking at the rail know it changed. Also
  // rewrites every currently-open session's harness-context.json: the
  // workflow registry is shared across the whole harness instance, so a
  // scan/connect anywhere changes what every session's `workflows` list
  // should say, not just the session that triggered the scan.
  // Returns the workflows freshly discovered under `root` (not the whole
  // merged registry) — callers use this to decide whether THIS scan turned
  // up something new worth an unprompted canvas render, without conflating
  // it with unrelated workflows some earlier scan already found elsewhere.
  const scanWorkflowsAndBroadcast = async (root: string): Promise<WorkflowInfo[]> => {
    const found = await workflowRegistry.scan(root);
    workflowsCache = await workflowRegistry.list();
    // Rewrite every open session's context file before broadcasting — a
    // listener reacting to workflows.changed (the SPA, or an agent that
    // happens to re-read the file right then) must never see the
    // notification before the file it describes is actually updated.
    await Promise.all(sessionManager.list().map((session) => writeSessionContext(session)));
    bus.publish({ type: "workflows.changed" });
    return found;
  };

  // The AI enrichment layer over the deterministic renders: one bounded
  // headless task per workflow (spawned on bind when no fresh cache exists,
  // or by the visualize macro's force refresh), whose validated JSON output
  // is persisted per-workflow and merged into the render on completion —
  // the render write alone hot-reloads any open pane via the canvas watcher.
  const enrichment = new CanvasEnrichmentCoordinator({
    tasks: taskManager,
    rerender: async (cwd, workflow) => {
      await renderWorkflowRenderFile(cwd, workflow);
    },
  });

  // Renders a session's bound workflow via the deterministic pipeline —
  // always against the live workflowsCache, never an LLM in the render
  // itself; a cheap no-op for an unbound session (the canvas router serves
  // the empty state on its own). Never throws (see core/canvas-render.ts);
  // best-effort, like every other canvas write here. The bind path
  // (PATCH /sessions/:id/workflow → rest.ts) and the UNPROMPTED call sites
  // (session-create/boot auto-render, via autoRenderCanvas — which won't
  // replace a workflow's existing render with an error panel when its
  // extraction fails) also kick the enrichment freshness check afterwards:
  // instant base diagram now, annotations merged in when the task lands.
  const renderCanvas = async (session: HarnessSession): Promise<void> => {
    await renderCanvasForSession(session, workflowsCache);
    await enrichment.ensureFresh(session, workflowsCache);
  };
  const autoRenderCanvas = async (session: HarnessSession): Promise<void> => {
    await renderCanvasForSession(session, workflowsCache, { preserveExistingOnFailure: true });
    await enrichment.ensureFresh(session, workflowsCache);
  };

  const initialWorkflowScan = scanWorkflowsAndBroadcast(launchDir).catch((err: unknown) => {
    console.error("[harness] initial workflow scan failed:", err);
    return [] as WorkflowInfo[];
  });

  const eventStorePath = options.eventStorePath ?? statePaths.events;
  const eventStore = createEventStore(eventStorePath);

  // Boot-time retention sweep: keeps events.ndjson within the 50 MB / 30-day
  // caps even on long-lived installs. Runs through the store's exclusive queue
  // so the sweep's read→filter→rename window never races a concurrent append.
  // Fire-and-forget — a slow FS is no reason to delay server startup.
  const runNdjsonSweep = (): void => {
    void eventStore.runExclusive(() => sweepNdjson(eventStorePath)).catch((err: unknown) => {
      console.error("[harness] events.ndjson retention sweep failed:", err);
    });
  };
  runNdjsonSweep();
  const ndjsonRetentionTimer = setInterval(runNdjsonSweep, NDJSON_RETENTION_SWEEP_MS);
  ndjsonRetentionTimer.unref?.();

  const harnessVersion = readVersion();
  const batcher = createHarnessEmitter({
    telemetryOptIn: options.telemetryOptIn,
    sdkName: "@sapiom/harness",
    sdkVersion: harnessVersion,
    apiKey: identity?.apiKey ?? null,
    endpoint: options.collectorUrl,
    context: {
      harnessVersion,
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
  });

  const resolveIngestSession = (harnessSessionId: string): IngestSessionContext | undefined => {
    const session = sessionManager.get(harnessSessionId);
    if (!session) return undefined;
    return {
      harness: session.harness,
      userId: identity?.userId ?? null,
      tenantId: identity?.tenantId ?? null,
      machineId,
      agentSessionId: session.agentSessionId,
    };
  };

  // Shared by the ingest pipeline, the Codex transcript tailer, and the UI
  // track endpoint — all three sources feed the same seq namespace so a given
  // harnessSessionId gets one consistent, gap-detectable seq space regardless
  // of which source produced the event. Declared here (before createRestRouter
  // and createIngestRouter) so the uiTrack closure can reference it lazily.
  const seqCounter = createSeqCounter();

  const app: Express = express();
  app.disable("x-powered-by");

  // Everything under /api requires the boot token; mounted as middleware
  // (not a router) so it also gates the workflows/macros routers below,
  // which declare their own absolute /api/* paths.
  app.use("/api", createBootTokenMiddleware(options.bootToken), express.json());
  app.use(
    "/api",
    createRestRouter({
      sessionManager,
      adapters,
      version: readVersion(),
      identity: identity ? { userId: identity.userId, organizationName: identity.organizationName } : null,
      listWorkflows: () => workflowRegistry.list(),
      listMacros: () => DEFAULT_MACROS,
      findWorkflow: (workflowPath) => workflowsCache.find((w) => w.path === workflowPath) ?? null,
      writeWorkspaceContext: writeSessionContext,
      renderCanvas,
      onTelemetryOptInChange: (optIn) => batcher.setTelemetryOptIn(optIn),
      onSessionCreated: (cwd, harnessSessionId) => {
        scanWorkflowsAndBroadcast(cwd)
          .then((found) => {
            // Only auto-render when THIS session's own directory turned up a
            // workflow — an unrelated project scanned earlier elsewhere in
            // the registry shouldn't unprompt-render into a brand new,
            // unrelated session's pane.
            if (found.length === 0) return;
            const session = sessionManager.get(harnessSessionId);
            if (session) return autoRenderCanvas(session);
          })
          .catch((err: unknown) => {
            console.error("[harness] workflow scan on session create failed:", err);
          });
      },
      launchDir,
      availableHarnesses: options.availableHarnesses,
      listTasks: () => taskManager.list(),
      firstRun: options.firstRun,
      consentSource: options.consentSource,
      consentEnvReason: options.consentEnvReason,
      uiTrack: {
        store: eventStore,
        batcher,
        nextSeq: (sessionId) => seqCounter.next(sessionId),
        machineId,
        userId: identity?.userId ?? null,
        tenantId: identity?.tenantId ?? null,
      },
      seedSampleProject: async () => {
        const { root, projectDir, created } = await seedExampleProject({
          targetRoot: options.sampleProjectRoot ?? statePaths.sampleProject,
        });
        return { root, projectDir, created };
      },
      settingsPath: statePaths.settings,
    }),
  );
  app.use(
    "/api",
    createCanvasRenderRouter({
      getSession: (harnessSessionId) => sessionManager.get(harnessSessionId),
      listWorkflows: () => workflowsCache,
    }),
  );
  app.use(
    createWorkflowsRouter(workflowRegistry),
    createFsRouter(),
    createMacrosRouter({
      listMacros: () => DEFAULT_MACROS,
      findWorkflow: (workflowPath) => workflowsCache.find((w) => w.path === workflowPath) ?? null,
      getSessionCwd: (harnessSessionId) => sessionManager.get(harnessSessionId)?.cwd ?? null,
      getBoundWorkflowPath: (harnessSessionId) => sessionManager.get(harnessSessionId)?.boundWorkflowPath ?? null,
      // The visualize macro is a FORCE refresh, not a plain re-render:
      // invalidate the extraction + enrichment caches, re-render the base
      // instantly, re-spawn the enrichment task. Its refusals map to the
      // router's existing error handling (already running → 409, codex
      // session → 400).
      renderCanvas: async (harnessSessionId) => {
        const session = sessionManager.get(harnessSessionId);
        if (session) await enrichment.forceRefresh(session, workflowsCache);
      },
      injectInput: async (harnessSessionId, text, submit) => {
        // Two-phase write: a combined text+\r lands in Claude Code as a
        // bracketed paste and never submits.
        await sessionManager.submitInput(harnessSessionId, text, submit);
      },
      runBackgroundTask: async (harnessSessionId, macro, prompt, workflowPath) => {
        // The router already 404'd on an unknown session (getSessionCwd),
        // so the session is present here; its harness kind decides whether
        // a headless run is even possible (TaskNotSupportedError → 400).
        const session = sessionManager.get(harnessSessionId);
        if (!session) throw new Error(`Unknown session '${harnessSessionId}'`);
        await taskManager.run({
          macroId: macro.id,
          label: macro.label,
          harnessSessionId,
          harness: session.harness,
          cwd: session.cwd,
          prompt,
          workflowPath,
        });
      },
      openUrl: async (url) => {
        await open(url);
      },
    }),
  );

  // Feeds the same seqCounter declared above — both hook POSTs and the Codex
  // transcript tailer run through processIngest(), which shares the counter.
  const ingestDeps: IngestDeps = {
    ingestToken: options.bootToken,
    normalize: normalizeHookEvent,
    resolveSession: resolveIngestSession,
    onAgentSessionResolved: (harnessSessionId, agentSessionId) => {
      sessionManager.setAgentSessionId(harnessSessionId, agentSessionId);
    },
    onSessionReady: (harnessSessionId) => {
      sessionManager.setReady(harnessSessionId);
    },
    store: eventStore,
    batcher,
    enrichFromTranscript: enrichTurnCompleted,
    onNormalizedEvent: (event: AnalyticsEvent) => {
      if (event.type !== "tool.call") return;
      const { toolInput, toolResponseSummary } = event.payload as {
        toolInput?: unknown;
        toolResponseSummary?: unknown;
      };
      // Each field is a discrete, already-complete string (not a live
      // stream) — flush() immediately so a port landing at the very end
      // of it (a common shape: "...started server on http://localhost:5544")
      // isn't held back waiting for a "next chunk" that will never arrive.
      if (typeof toolInput === "string") {
        portDetector.feed(toolInput, event.harnessSessionId);
        portDetector.flush(event.harnessSessionId);
      }
      if (typeof toolResponseSummary === "string") {
        portDetector.feed(toolResponseSummary, event.harnessSessionId);
        portDetector.flush(event.harnessSessionId);
      }
    },
    onError: (err) => console.error("[harness] ingest processing error:", err),
    seqCounter,
  };

  // /ingest authenticates itself (bearer ingestToken, not X-Harness-Token) —
  // it must not sit behind the /api boot-token middleware above.
  app.use(createIngestRouter(ingestDeps));

  // Codex has no hooks, so a live session's entire analytics eventSource is
  // its rollout file (see core/collector/codex-tailer.ts). On "running", find
  // that file and start tailing it, feeding each translated {hookEvent,
  // payload} into the exact same processIngest() pipeline a hook POST would
  // hit — same normalizer, same transcript enrichment, same store/batcher,
  // same seqCounter. On "exited", synthesize the SessionEnd the rollout
  // format has no line of its own for, and stop.
  const codexTailers = new Map<string, CodexTailerHandle>();

  async function discoverCodexRolloutPath(session: HarnessSession): Promise<string | null> {
    const deadline = Date.now() + CODEX_ROLLOUT_DISCOVERY_TIMEOUT_MS;
    const sinceMs = Date.parse(session.createdAt);
    for (;;) {
      const found = await findRolloutFile(
        session.agentSessionId
          ? { cwd: session.cwd, agentSessionId: session.agentSessionId, homeDir: options.codexHomeDir }
          : {
              cwd: session.cwd,
              sinceMs: Number.isNaN(sinceMs) ? undefined : sinceMs,
              homeDir: options.codexHomeDir,
            },
      );
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, CODEX_ROLLOUT_DISCOVERY_POLL_MS));
    }
  }

  async function startCodexTailerFor(harnessSessionId: string): Promise<void> {
    if (codexTailers.has(harnessSessionId)) return;
    const session = sessionManager.get(harnessSessionId);
    if (!session) return;

    const rolloutPath = await discoverCodexRolloutPath(session);
    if (!rolloutPath) {
      console.error(
        `[harness] codex tailer: no rollout file found for session ${harnessSessionId} (cwd=${session.cwd}) within ${CODEX_ROLLOUT_DISCOVERY_TIMEOUT_MS}ms`,
      );
      return;
    }
    // The session may have exited (or already started another tailer via a
    // status-change re-entry) while discovery was polling.
    if (codexTailers.has(harnessSessionId)) return;
    if (sessionManager.get(harnessSessionId)?.status !== "running") return;

    const tailer = tailCodexRollout({
      rolloutPath,
      // A fresh launch was found by cwd+sinceMs, not an exact agentSessionId
      // match — which means it's necessarily the file THIS session just
      // caused Codex to create, so its entire content (including the
      // session_meta line discovery just proved exists) is new to us. A
      // resume's agentSessionId match, by contrast, points at a file with
      // real prior history that should stay unemitted.
      startFromBeginning: !session.agentSessionId,
      onEvent: (hookEvent, payload) => {
        const body: IngestRequestBody = { hookEvent, harnessSessionId, payload };
        void processIngest(body, ingestDeps, seqCounter).catch((err: unknown) => {
          console.error("[harness] codex tailer ingest error:", err);
        });
      },
      onError: (err) => console.error("[harness] codex tailer parse error:", err),
    });
    codexTailers.set(harnessSessionId, tailer);
  }

  sessionManager.onStatusChange((session) => {
    // The codex tailer is only needed for harnesses whose analytics come
    // from the rollout file (eventSource: "transcript-tail"). Harnesses with
    // eventSource: "hooks" (claude-code) drive the same pipeline via real
    // hook POSTs; no tailer needed. Routing through eventSource rather than
    // a hardcoded "codex" string means adding a new transcript-tail harness
    // is a registry line + adapter file, not a server-index change.
    if (adapters[session.harness]?.eventSource !== "transcript-tail") return;
    if (session.status === "running") {
      startCodexTailerFor(session.id).catch((err: unknown) => {
        console.error("[harness] codex tailer startup failed:", err);
      });
    } else if (session.status === "exited") {
      const tailer = codexTailers.get(session.id);
      if (tailer) {
        tailer.emitSessionEnd(session.exitCode != null ? `pty exited (code ${session.exitCode})` : undefined);
        codexTailers.delete(session.id);
      }
    }
  });

  // Canvas is intentionally unauthenticated (see canvas.ts) — served straight
  // off the session's cwd, no boot token required.
  app.use(
    createCanvasRouter((harnessSessionId) => {
      const session = sessionManager.get(harnessSessionId);
      return session ? { cwd: session.cwd, boundWorkflowPath: session.boundWorkflowPath } : undefined;
    }),
  );

  // NOTE: mount additional routers above this line — the static/SPA fallback
  // below is a catch-all and must stay last.
  const webDir = options.webDir ?? join(packageRoot(), "dist", "web");
  app.use(createStaticRouter(webDir));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[harness] unhandled request error:", err);
    res.status(500).json({ error: "internal error" });
  });

  const httpServer: HttpServer = createHttpServer(app);

  const terminalWss = new WebSocketServer({ noServer: true });
  const eventsWss = new WebSocketServer({ noServer: true });
  attachWebSocketRouters(httpServer, [
    {
      path: "/ws/terminal",
      wss: terminalWss,
      onConnection: createTerminalWebSocketHandler(sessionManager, options.bootToken),
    },
    {
      path: "/ws/events",
      wss: eventsWss,
      onConnection: createEventsWebSocketHandler(bus, options.bootToken),
    },
  ]);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  // The app otherwise opens to an empty terminal pane — not fire-and-forget
  // because a spawn failure here (e.g. claude not on PATH) is worth
  // surfacing loudly, but also not awaited before returning: startServer()
  // resolving shouldn't wait on a real pty spawn.
  if (options.autoCreateSession ?? true) {
    const harness = options.defaultHarnessKind ?? "claude-code";
    sessionManager
      .create({ cwd: launchDir, harness })
      .then(async (session) => {
        // Reuses the scan already kicked off above rather than scanning
        // launchDir twice — only renders when it actually found something,
        // same "discoverable" gate as the REST onSessionCreated path.
        const found = await initialWorkflowScan;
        if (found.length > 0) await autoRenderCanvas(session);
      })
      .catch((err: unknown) => {
        console.error("[harness] auto-create boot session failed:", err);
      });
  }

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;
  // Covers the ephemeral `port: 0` case (tests) where `options.port` above
  // was 0 and therefore never a real port to exclude — the actual bound
  // port is only known now.
  portDetector.addExcludedPort(actualPort);

  return {
    port: actualPort,
    sessionManager,
    close: async () => {
      clearInterval(workflowsCacheTimer);
      clearInterval(sessionSweepTimer);
      clearInterval(ndjsonRetentionTimer);
      canvasWatcher.stopAll();
      workspaceWatcher.stopAll();
      for (const tailer of codexTailers.values()) tailer.stop();
      codexTailers.clear();
      // Closing the HTTP/WS server doesn't touch unrelated child processes
      // on its own — without this, every live claude/codex pty outlives
      // the harness server itself (e.g. after Ctrl+C or in a script that
      // expects the process to actually exit once close() resolves).
      // Await kills with a bounded timeout so shutdown never hangs: if a
      // process somehow survives both SIGTERM and SIGKILL within the
      // escalation window (shouldn't happen), we still resolve and let the
      // HTTP server close proceed. The SIGKILL escalation inside each kill()
      // itself is bounded (KILL_ESCALATION_MS + KILL_ESCALATION_CONFIRM_MS
      // = 2500ms); the outer timeout here is a final safety net above that.
      const SHUTDOWN_KILL_TIMEOUT_MS = 5_000;
      const killsSettled = Promise.all([sessionManager.killAll(), taskManager.killAll()]);
      const shutdownTimeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_KILL_TIMEOUT_MS));
      await Promise.race([killsSettled, shutdownTimeout]);
      void batcher.close();
      terminalWss.close();
      eventsWss.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
};
