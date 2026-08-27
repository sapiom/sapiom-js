/**
 * Harness server — integration point for every workstream.
 *
 * Single process: serves the built SPA from dist/web, the REST surface, the
 * webhook ingest endpoint, canvas file serving, and the two WebSocket
 * endpoints (/ws/terminal, /ws/events). Binds 127.0.0.1 only. See
 * src/shared/types.ts for the full protocol contract.
 */

import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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
  SessionRecord,
  SystemPromptDelivery,
  WorkflowInfo,
} from "../shared/types.js";
import { JSON_BODY_LIMIT_BYTES } from "../shared/types.js";
import { unhandledRequestErrorHandler } from "./error-handler.js";
import { resolveStatePaths } from "../core/paths.js";
import {
  SessionManager,
  type LaunchOptsBuilder,
} from "../core/session-manager.js";
import { TaskManager } from "../core/task-manager.js";
import { createClaudeCodeAdapter } from "../core/adapters/claude-code.js";
import { createCodexAdapter } from "../core/adapters/codex.js";
import {
  WorkflowRegistry,
  type WorkflowRegistryLike,
  createWorkflowsRouter,
} from "../core/workflow-registry.js";
import { DEFAULT_MACROS } from "../core/macros.js";
import { createEventStore } from "../core/collector/store.js";
import {
  createClaudeTranscriptEnricher,
  createSessionRecordReader,
} from "../core/session-record.js";
import {
  buildRehydrationBrief,
  systemPromptDeliveryFor,
} from "../core/rehydration.js";
import {
  createRollingSummarizer,
  readRollingSummary,
} from "../core/rolling-summary.js";
import {
  backfillSessionRecords,
  createRecordArchive,
} from "../core/record-archive.js";
import { createHarnessEmitter } from "../core/collector/analytics-emitter.js";
import { migrateHarnessIdentity } from "../core/collector/identity-migration.js";
import { normalizeHookEvent } from "../core/collector/normalizer.js";
import { enrichTurnCompleted } from "../core/collector/transcript.js";
import { createSeqCounter } from "../core/collector/seq.js";
import {
  findRolloutFile,
  tailCodexRollout,
  type CodexTailerHandle,
} from "../core/collector/codex-tailer.js";
import { getOrCreateMachineId } from "../cli/machine-id.js";
import { loadSettings, pruneDeadRecentDirs } from "../cli/settings.js";
import type { HarnessIdentity } from "../cli/auth.js";
import { generateClaudeSettings } from "../core/inject/claude-settings.js";
import { generateMcpConfig, type McpDevServerCommand } from "../core/inject/mcp-config.js";
import { generateSystemPromptFile } from "../core/inject/system-prompt.js";
import { generateSkillsPlugin } from "../core/inject/skills-plugin.js";
import {
  removeGeneratedSessionDir,
  sweepGeneratedDirs,
} from "../core/inject/retention.js";
import { CanvasWatcherManager } from "../core/canvas-watcher.js";
import { WorkspaceWatcherManager } from "../core/workspace-watcher.js";
import { InstallWatcherManager } from "../core/install-watcher.js";
import { ExecutionDetector } from "../core/execution-detector.js";
import { PortDetector, portFromUrl } from "../core/port-detector.js";
import { EventBus } from "../core/event-bus.js";
import {
  prepareHarnessContextForResume,
  writeHarnessContext,
  writeHarnessContextForLaunch,
} from "../core/workspace-context.js";
import { ensureCanvasTemplate } from "../core/canvas-template.js";
import { renderCanvasForSession } from "../core/canvas-render.js";
import { invalidateExtractionCache } from "../core/canvas-cache.js";
import { sweepNdjson } from "../core/collector/store-retention.js";
import {
  createDefinitionSlugResolver,
  resolveAgentsBaseUrl,
} from "../core/definition-slug-resolver.js";
import { resolveManifestName } from "../core/definition-name.js";
import { createBootTokenMiddleware } from "./auth.js";
import { createApiKeyProvider } from "../core/api-key-provider.js";
import { createRestRouter } from "./rest.js";
import { createStaticRouter } from "./static.js";
import { createTerminalWebSocketHandler } from "./terminal-ws.js";
import { createEventsWebSocketHandler } from "./events-ws.js";
import { attachWebSocketRouters } from "./ws-router.js";
import {
  createIngestRouter,
  processIngest,
  type IngestDeps,
  type IngestRequestBody,
  type IngestSessionContext,
} from "./ingest.js";
import { createCanvasRouter } from "./canvas.js";
import { createCanvasRenderRouter } from "./canvas-render.js";
import { createWorkflowGraphRouter } from "./workflow-graph.js";
import { createStudioRailRouter } from "./studio-rail.js";
import { createAgentMoveRouter, remapUnder } from "./agent-move.js";
import { createMacrosRouter } from "./macros.js";
import { createFsRouter } from "./fs.js";
import { createRunsRouter } from "./runs.js";
import { createTemplatesRouter } from "./templates.js";
import { createAccountRouter } from "./account.js";
import { createActionsRouter } from "./actions.js";
import {
  createAuthRouter,
  createMutableAuthState,
} from "./auth-routes.js";
// resolveAgentsBaseUrl is imported above from definition-slug-resolver.js
// (an identical helper); the runs router reuses it for its agents base URL.

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
  /** Host-supplied launcher for the local sapiom-dev MCP server, replacing the
   *  default `npx @sapiom/mcp@latest`. The Electron host passes its own binary
   *  (GUI-subsystem — allocates no console window on Windows, where the npx
   *  chain's cmd.exe popped a persistent one that users closed, killing the
   *  server) plus the entry script it installed into the per-user npm prefix.
   *  See core/inject/mcp-config.ts. */
  sapiomDevMcp?: McpDevServerCommand;
  /** Root directory per-session generated agent configs are written under —
   *  and cleaned up from (exit-time delete + boot-time sweep, see
   *  core/inject/retention.ts). Defaults to `<stateRoot>/generated`. */
  generatedRoot?: string;
  /** Root directory archived session records are written under — the copies
   *  that outlive events.ndjson's retention (see core/record-archive.ts).
   *  Defaults to `<stateRoot>/records`. */
  recordsRoot?: string;
  collectorUrl?: string;
  /** Workflow registry file. Defaults to `<stateRoot>/workflows.json`. */
  workflowsRegistryPath?: string;
  /** Local analytics ndjson sink. Defaults to `<stateRoot>/events.ndjson`. */
  eventStorePath?: string;
  /** Overrides the home directory codex rollout discovery scans
   * (`<home>/.codex/sessions/...`). Defaults to the real OS home dir; tests
   * point this at a fixture tree instead of touching `~/.codex` for real. */
  codexHomeDir?: string;
  /** Overrides the home directory Claude Code transcript discovery scans
   * (`<home>/.claude/projects/...`). Defaults to the real OS home dir; tests
   * point this at a fixture tree instead of touching `~/.claude` for real. */
  claudeHomeDir?: string;
  /** Directory the built SPA lives in. Defaults to dist/web next to this module. */
  webDir?: string;
  /** The directory the CLI was launched against — scanned for workflows at
   *  boot so the rail isn't empty until a manual "+ Connect", and (unless
   *  autoCreateSession is false) where the boot session is created. */
  launchDir?: string;
  /** The host's default parent directory for NEW agent projects (the
   *  add-workspace template and idea doors), before the user's `projectRoot`
   *  setting overrides it. Defaults to `launchDir` — correct for the CLI, where
   *  the developer chose that directory deliberately. The Electron host passes
   *  `<launchDir>/projects` so user code doesn't land in the state directory's
   *  own listing. Only the host knows which it is, which is why this is an
   *  option rather than something the SPA infers. */
  projectRoot?: string;
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
function workflowListsEqual(
  a: readonly WorkflowInfo[],
  b: readonly WorkflowInfo[],
): boolean {
  if (a.length !== b.length) return false;
  // NUL separates the fields because it can't occur in any of them. Keep it
  // written as the escape `\u0000` — a literal NUL byte in the source makes
  // grep and ripgrep classify this whole file as binary and silently skip it.
  // Mutable cloud-build fields are deliberately enriched at serve/render
  // time; the registry snapshots compared here never own those fields.
  const key = (w: WorkflowInfo): string =>
    `${w.path}\u0000${w.name}\u0000${w.definitionId ?? ""}\u0000${w.definitionSlug ?? ""}\u0000${w.source}`;
  const setA = new Set(a.map(key));
  return b.every((w) => setA.has(key(w)));
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot(), "package.json"), "utf8"),
    ) as {
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
function createDefaultBuildLaunchOpts(
  apiKey: string | null,
  generatedRoot?: string,
  rehydration?: {
    /** Brief text for a prior session id, or null when nothing was recorded. */
    buildBrief: (rehydrateFrom: string) => Promise<string | null>;
    /** Which channel this harness receives a brief on. */
    deliveryFor: (harness: HarnessKind) => SystemPromptDelivery;
  },
  sapiomDevMcp?: McpDevServerCommand,
): LaunchOptsBuilder {
  return async (harnessSessionId, req) => {
    // Portable continue (SAP-2059). Resolved before the prompt file is
    // written, because for a `launch-flag` harness the brief IS part of that
    // file. Best-effort throughout: a brief that can't be assembled leaves
    // `rehydratedFrom` unset and the session launches as an ordinary fresh
    // one rather than failing — see CreateSessionRequest.rehydrateFrom.
    //
    // Only ever set on create(): resume() calls this builder with the persisted
    // HarnessSession, which carries no `rehydrateFrom`, so a rehydrated session
    // that is later resumed does not get the brief a second time (the agent's
    // own conversation already holds it).
    const rehydrateFrom = req.rehydrateFrom;
    const brief =
      rehydrateFrom && rehydration
        ? await rehydration.buildBrief(rehydrateFrom).catch((err: unknown) => {
            console.error("[harness] rehydration brief failed:", err);
            return null;
          })
        : null;
    // The other channel (post-ready injection, for a harness with no prompt
    // flag) is driven from the session status handler in startServer — the
    // brief must not go into a file that adapter never reads.
    const viaSystemPrompt =
      brief !== null && rehydration?.deliveryFor(req.harness) === "launch-flag";

    // Pin Claude's ANSI theme to the app theme so the terminal's own palette
    // (Terminal.tsx DARK_ANSI/LIGHT_ANSI) controls its colors — matched base or
    // dim text loses contrast. Only when the theme is known: an unthemed path
    // (server-side auto-create, a legacy session resumed before this existed)
    // omits it and Claude keeps its default 256-color rendering, exactly as before.
    const claudeTheme =
      req.theme === "light" ? "light-ansi" : req.theme === "dark" ? "dark-ansi" : undefined;

    const [settings, mcpConfigFile, systemPromptFile, pluginDir] =
      await Promise.all([
        generateClaudeSettings({
          harnessSessionId,
          generatedRoot,
          ...(claudeTheme ? { claudeTheme } : {}),
        }),
        generateMcpConfig(harnessSessionId, {
          environment: process.env.SAPIOM_ENVIRONMENT,
          apiKey,
          generatedRoot,
          harnessVersion: readVersion(),
          ...(sapiomDevMcp ? { devServer: sapiomDevMcp } : {}),
        }),
        generateSystemPromptFile(harnessSessionId, {
          generatedRoot,
          ...(viaSystemPrompt ? { appendix: brief } : {}),
        }),
        generateSkillsPlugin(harnessSessionId, { generatedRoot }),
      ]);
    return {
      settingsFile: settings.settingsPath,
      mcpConfigFile,
      systemPromptFile,
      ...(pluginDir ? { pluginDir } : {}),
      // Set on BOTH channels: the post-ready path hasn't delivered yet, but a
      // brief exists and will, and this is the flag that tells it to.
      ...(brief !== null && rehydrateFrom ? { rehydratedFrom: rehydrateFrom } : {}),
    };
  };
}

export const startServer = async (
  options: HarnessServerOptions,
): Promise<HarnessServer> => {
  const host = options.host ?? "127.0.0.1";
  const identity = options.identity ?? null;
  // The single source of truth for the Sapiom API key (`sk_…`) that Studio
  // actions authenticate with — distinct from the per-boot boot token that only
  // gates the local /api surface. Seeded from the boot-time identity; its
  // refresh() re-reads the shared credential store so a rotated/re-logged-in key
  // recovers a 401 in place instead of locking the Studio.
  const apiKeyProvider = createApiKeyProvider(identity?.apiKey ?? null, {
    environment: process.env.SAPIOM_ENVIRONMENT,
  });

  // Mutable auth state — seeded from the boot-time identity and updated by the
  // in-app auth routes (POST /api/auth/start, POST /api/auth/disconnect). The
  // auth router mutates this on every sign-in/sign-out; GET /api/auth/status
  // reads it directly so the SPA always sees the live state.
  const authState = createMutableAuthState({
    authenticated: identity !== null,
    organizationName: identity?.organizationName ?? null,
  });
  const statePaths = resolveStatePaths(options.stateRoot);
  const machineId =
    options.machineId ?? (await getOrCreateMachineId(statePaths.machineId));

  // One-way identity migration: seed ~/.sapiom/analytics.json from the
  // legacy harness machine-id so existing installs keep the same anonymous_id
  // after the upgrade (longitudinal join key survives). No-op when analytics.json
  // already exists or when HOME is unwritable.
  await migrateHarnessIdentity(statePaths.machineId);
  const launchDir = options.launchDir ?? process.cwd();

  // Serve-time slug enrichment: resolves each workflow's definitionSlug from
  // the Sapiom Agents API when it's absent (deployed sapiom.json files carry
  // only { "definitionId": "188" }, not the slug). Constructed once per server
  // boot; caches successful id→slug resolutions in-memory (ids are stable).
  // Never throws — a failed resolution leaves definitionSlug as-is.
  const slugResolver = createDefinitionSlugResolver({
    apiKey: () => apiKeyProvider.getKey(),
    baseUrl: resolveAgentsBaseUrl(),
  });

  /** Returns a copy of the workflow list with definition metadata filled in
   *  from the Agents API for every linked workflow. Build status is mutable,
   *  so it is refreshed even when the stable slug is already present.
   *  Resolves all lookups in parallel. Never mutates the registry. */
  const enrichWorkflows = async (
    workflows: WorkflowInfo[],
  ): Promise<WorkflowInfo[]> => {
    return Promise.all(
      workflows.map(async (workflow) => {
        if (workflow.definitionId == null) return workflow;
        const metadata = await slugResolver.resolveMetadata(
          String(workflow.definitionId),
        );
        if (metadata == null) return workflow;
        return {
          ...workflow,
          definitionSlug: metadata.slug ?? workflow.definitionSlug,
          activeBuildRunId: metadata.activeBuildRunId,
          activeBuildRunStatus: metadata.activeBuildRunStatus,
        };
      }),
    );
  };

  const adapters: Partial<Record<HarnessKind, HarnessAdapter>> =
    options.adapters ??
    ({
      "claude-code": createClaudeCodeAdapter(),
      codex: createCodexAdapter(),
    } satisfies Partial<Record<HarnessKind, HarnessAdapter>>);

  const bus = new EventBus();
  const canvasWatcher = new CanvasWatcherManager({
    onChange: (harnessSessionId) =>
      bus.publish({ type: "canvas.reload", harnessSessionId }),
    // A workflow SOURCE edit auto re-renders the bound workflow — deterministic
    // and free, so there's nothing to wait for and no button to press. Uses the
    // preserve-on-failure path: while an agent is mid-edit the sources are
    // transiently un-buildable, and flashing an extraction-error panel over a
    // perfectly good diagram reads as broken. So keep the last good render until
    // a later watched .ts/.tsx edit extracts successfully, then swap it in (the
    // write flows back through onChange above as the iframe reload). Other fixes
    // need an explicit Visualize retry because the watcher is intentionally
    // source-limited. Only a workflow that has never rendered shows the honest
    // error immediately.
    onSourceChange: (harnessSessionId) => {
      const session = sessionManager.get(harnessSessionId);
      if (session) void autoRenderCanvas(session).catch(() => {});
    },
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
    onPort: (harnessSessionId, port, url) =>
      bus.publish({ type: "port.detected", harnessSessionId, port, url }),
    excludedPorts,
  });
  // Same tool.call output feed as portDetector: catch `✓ Started execution
  // <id>` so the SPA can start polling that run's live state (see
  // core/execution-detector.ts). Local runs are rendered from their final
  // result, not polled, so only prod-run announcements flow through here.
  const executionDetector = new ExecutionDetector({
    onExecution: (harnessSessionId, executionId, target) =>
      bus.publish({
        type: "execution.started",
        harnessSessionId,
        executionId,
        target,
      }),
  });

  // Declared before sessionManager: its context writers need workflowsCache
  // in scope to resolve a session's boundWorkflowPath into a full WorkflowInfo.
  // scanWorkflowsAndBroadcast stays defined below sessionManager instead,
  // since it needs sessionManager
  // itself (to rewrite every open session's context file on a registry change) —
  // no circularity, since the context callbacks threaded into SessionManager's
  // constructor don't need sessionManager themselves.
  const workflowRegistry = new WorkflowRegistry(
    options.workflowsRegistryPath ?? statePaths.workflows,
  );
  // Boot-time hygiene, before the first list(): drop registry entries whose
  // path no longer exists on disk (deleted projects, temp dirs a crashed run
  // left registered) so the rail — and every harness-context.json written
  // below — never resurrects a dead project. Deliberately awaited: nothing
  // downstream should ever observe the pre-prune list.
  try {
    const prunedWorkflows = await workflowRegistry.prune();
    for (const workflow of prunedWorkflows) {
      console.error(
        `[harness] pruned agent registry entry with missing path: ${workflow.path}`,
      );
    }
  } catch (err) {
    console.error("[harness] agent registry prune failed:", err);
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

  const boundWorkflowForSession = (session: HarnessSession): WorkflowInfo | null =>
    session.boundWorkflowPath
      ? (workflowsCache.find((workflow) => workflow.path === session.boundWorkflowPath) ?? null)
      : null;

  /**
   * Writes HARNESS_CONTEXT_FILE for a single session, resolving its
   * `boundWorkflowPath` against the live registry so the file always
   * reflects the session's actual current binding (not just what a caller
   * happened to have on hand) — and the full agent list. Bind/unbind and
   * registry refreshes use this best-effort writer; create and resume use
   * their strict pre-spawn counterparts below.
   */
  const writeSessionContext = async (
    session: HarnessSession,
  ): Promise<void> => {
    await writeHarnessContext(session, boundWorkflowForSession(session), workflowsCache);
  };

  const initializeSessionContext = async (
    session: HarnessSession,
  ): Promise<void> => {
    await writeHarnessContextForLaunch(session, boundWorkflowForSession(session), workflowsCache);
  };

  const prepareSessionContext = async (
    session: HarnessSession,
  ): Promise<void> => {
    await prepareHarnessContextForResume(session, boundWorkflowForSession(session), workflowsCache);
  };

  // Declared before the launch-opts builder (rather than beside the ingest
  // pipeline, where the rest of the event wiring lives) because portable
  // continue resolves a rehydration brief from this reader at session-create
  // time — see createDefaultBuildLaunchOpts below.
  const eventStorePath = options.eventStorePath ?? statePaths.events;
  const eventStore = createEventStore(eventStorePath);

  // Archived session records — the copies that survive events.ndjson's 50 MB /
  // 30-day retention (core/record-archive.ts). Declared here, above the session
  // manager, because the "exited" handler archives through it.
  const recordsRoot = options.recordsRoot ?? statePaths.records;
  const recordArchive = createRecordArchive({ root: recordsRoot });

  // Past-session transcripts, rebuilt from the events above rather than from
  // any vendor's history file — the same code path for claude-code and codex.
  // The claude enricher is a pure bonus on top: when that transcript happens
  // to still exist, the final turn gains its model/usage; when it doesn't, the
  // record renders unchanged.
  const sessionRecordReader = createSessionRecordReader(eventStore, {
    enrichFinalTurn: createClaudeTranscriptEnricher(),
    archive: recordArchive,
  });

  /**
   * Fold a session's record from the events and archive it — the write that
   * makes its history outlive the log. Idempotent (it replaces any earlier
   * archive of the same conversation), detached, and silent about nothing: a
   * failure is logged and never propagated, because a session's exit must not
   * fail over its bookkeeping.
   *
   * Folded via `readFromEvents`, deliberately not `read`: re-archiving whatever
   * `read` returned would compact an already-compacted excerpt and re-stamp it
   * with a fresh `archivedAt`, making a stale copy look current.
   *
   * The sweep runs right after a write because a write is the only thing that
   * grows the store — enforcing the caps at the moment they can be exceeded
   * beats waiting for the next boot.
   */
  const archiveSessionRecord = async (harnessSessionId: string): Promise<void> => {
    const record = await sessionRecordReader.readFromEvents(harnessSessionId);
    if (!record) return;
    if (!(await recordArchive.write(record))) return;
    await recordArchive.sweep();
  };
  const archiveSessionRecordDetached = (harnessSessionId: string): void => {
    void archiveSessionRecord(harnessSessionId).catch((err: unknown) => {
      console.error("[harness] session record archive failed:", err);
    });
  };

  // Exit-time deletion of generated/<id> (see the onStatusChange handler
  // below) can race a fast resume(): resume regenerates the dir via
  // buildLaunchOpts, and the rm scheduled at the previous exit could still
  // be in flight. Serialize by awaiting any pending removal for this id
  // before (re)generating its files.
  const generatedRoot = options.generatedRoot ?? statePaths.generated;
  const pendingGeneratedRemovals = new Map<string, Promise<void>>();

  /**
   * The git branch the PRIOR session was last on, from whichever adapter
   * recorded it — our own events never carry one. One adapter history scan per
   * rehydrate, which is a user-initiated "continue this session" click rather
   * than a hot path (the reason `GET /sessions/history` avoids per-row probes
   * doesn't apply to a single deliberate action). Null for a harness whose
   * transcript doesn't record a branch, and never throws.
   */
  const priorGitBranch = async (record: SessionRecord): Promise<string | null> => {
    if (!record.cwd || !record.agentSessionId) return null;
    const adapter = adapters[record.harness];
    if (!adapter) return null;
    try {
      const rows = await adapter.listPastSessions(record.cwd);
      return rows.find((row) => row.agentSessionId === record.agentSessionId)?.gitBranch ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Portable continue: the brief text for a `rehydrateFrom` id, or null when
   * our event log holds nothing for it.
   *
   * Closes over `sessionManager` (declared just below, since it consumes the
   * builder this feeds) for the prior session's title and workflow binding —
   * safe because nothing can create a session before the manager that creates
   * them exists.
   */
  const resolveRehydrationBrief = (rehydrateFrom: string): Promise<string | null> =>
    buildRehydrationBrief(rehydrateFrom, {
      readRecord: (id) => sessionRecordReader.read(id),
      readSummary: (harnessSessionId) => readRollingSummary(generatedRoot, harnessSessionId),
      resolveContext: async (record) => {
        // The earliest merged session the registry still knows — the record's
        // own primary id first, so a conversation that spans a resume reports
        // where it began rather than whichever segment happens to be indexed.
        const prior = record.mergedSessionIds
          .map((id) => sessionManager.get(id))
          .find((session) => session !== undefined);
        const workflowPath = prior?.boundWorkflowPath ?? null;
        const workflow = workflowPath
          ? (workflowsCache.find((w) => w.path === workflowPath) ?? null)
          : null;
        return {
          title: prior?.title ?? null,
          gitBranch: await priorGitBranch(record),
          workflow: workflow
            ? { name: workflow.name, path: workflow.path, definitionId: workflow.definitionId }
            : null,
        };
      },
    });

  const innerBuildLaunchOpts =
    options.buildLaunchOpts ??
    createDefaultBuildLaunchOpts(
      identity?.apiKey ?? null,
      generatedRoot,
      {
        buildBrief: resolveRehydrationBrief,
        deliveryFor: (harness) => systemPromptDeliveryFor(adapters[harness]),
      },
      options.sapiomDevMcp,
    );
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
    writeWorkspaceContext: initializeSessionContext,
    prepareWorkspaceContext: prepareSessionContext,
    ensureCanvasTemplate,
  });
  await sessionManager.init();

  const sessionSweepTimer = setInterval(
    () => sessionManager.sweepDeadSessions(),
    SESSION_LIVENESS_SWEEP_MS,
  );
  sessionSweepTimer.unref?.();

  // Portable continue, second channel: for a harness whose adapter never puts
  // `systemPromptFile` in front of the agent, the brief is injected once the
  // session reports `ready` — not merely "running", which for a TUI sitting on
  // a "trust this directory?" prompt would feed the brief to the prompt. No
  // adapter shipped today needs this (both declare `launch-flag`), so it is
  // dormant rather than dead: a new harness with no prompt flag gets working
  // rehydration from one line in its adapter.
  const briefsDelivered = new Set<string>();
  sessionManager.onStatusChange((session) => {
    if (session.status === "exited") {
      briefsDelivered.delete(session.id);
      return;
    }
    const rehydratedFrom = session.rehydratedFrom;
    if (!session.ready || !rehydratedFrom) return;
    if (systemPromptDeliveryFor(adapters[session.harness]) !== "post-ready-injection") return;
    if (briefsDelivered.has(session.id)) return;
    // Claimed before the await so a burst of status frames can't double-inject.
    briefsDelivered.add(session.id);
    void (async () => {
      const brief = await resolveRehydrationBrief(rehydratedFrom);
      if (!brief) return;
      // submit:true — the brief has to enter the conversation to be context at
      // all; left unsubmitted it would just sit in the composer as a wall of
      // text the user has to deal with before they can type.
      await sessionManager.submitInput(session.id, brief, true);
    })().catch((err: unknown) => {
      briefsDelivered.delete(session.id);
      console.error("[harness] post-ready rehydration injection failed:", err);
    });
  });

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
      void removeGeneratedSessionDir(taskId, { generatedRoot }).catch(
        (err: unknown) => {
          console.error("[harness] task generated-dir cleanup failed:", err);
        },
      );
    },
  });
  taskManager.onStatusChange((task) => {
    bus.publish({ type: "task.status", task });
  });

  // Rolling summary (opt-in, `HarnessSettings.rollingSummary`): folds a live
  // session's record into a ≤500-word summary.md that a later portable
  // continue reads. Everything about it is detached from the session's own
  // path — `noteEvent` is synchronous and the fold is a separate headless
  // process — so a turn is never slower or riskier for it being on. A codex
  // session produces none (no `launchTask`); its briefs degrade to
  // last-N-turns, which is also the default for everyone with the setting off.
  const rollingSummarizer = createRollingSummarizer({
    generatedRoot,
    enabled: async () => (await loadSettings(statePaths.settings)).rollingSummary === true,
    readRecord: (harnessSessionId) => sessionRecordReader.read(harnessSessionId),
    getSession: (harnessSessionId) => {
      const session = sessionManager.get(harnessSessionId);
      return session ? { harness: session.harness, cwd: session.cwd } : undefined;
    },
    runTask: (req) => taskManager.run(req),
  });
  taskManager.onStatusChange((task) => rollingSummarizer.noteTaskStatus(task));

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
  // workspace, prune dead paths, reconcile its cwd, and — only when the workflow
  // list actually changed — rewrite every open session's context file and
  // broadcast `workflows.changed` (the SPA refetches /api/workflows on it).
  // Path pruning respects the ENOENT/ENOTDIR-only guard. The scan additionally
  // removes scan-sourced rows in this cwd's traversal envelope when their
  // marker disappears or becomes invalid; manually connected folders remain.
  const rescanWorkspaceForSession = async (
    harnessSessionId: string,
  ): Promise<void> => {
    const session = sessionManager.get(harnessSessionId);
    if (!session || session.status === "exited") return;
    const before = workflowsCache;
    await workflowRegistry.prune();
    await workflowRegistry.scan(session.cwd);
    const after = await workflowRegistry.list();
    workflowsCache = after;

    // A removed project must not leave a live session permanently bound to a
    // path that the registry can no longer resolve. Clear only stale bindings;
    // the triggering session may immediately auto-bind to another candidate
    // below its cwd in the block that follows.
    const registeredPaths = new Set(after.map((workflow) => workflow.path));
    for (const openSession of sessionManager.list()) {
      if (
        openSession.status !== "exited" &&
        openSession.boundWorkflowPath &&
        !registeredPaths.has(openSession.boundWorkflowPath)
      ) {
        sessionManager.setBoundWorkflowPath(openSession.id, null);
      }
    }

    // Auto-bind: if this session is still unbound, find the workflow at or
    // directly under its cwd and bind it — same mechanism as
    // PATCH /api/sessions/:id/workflow (setBoundWorkflowPath +
    // writeSessionContext + renderCanvas). Only runs once: the guard
    // `!session.boundWorkflowPath` is false on every subsequent rescan once
    // the session is bound, so this is idempotent and never overrides an
    // explicit/persisted binding.
    if (!session.boundWorkflowPath) {
      const cwdSep = session.cwd + sep;
      const candidate =
        after.find((w) => w.path === session.cwd) ??
        after
          .filter((w) => w.path.startsWith(cwdSep))
          .sort((a, b) => a.path.length - b.path.length)[0] ??
        null;
      if (candidate) {
        sessionManager.setBoundWorkflowPath(session.id, candidate.path);
        // Re-read: setBoundWorkflowPath mutates the session object in place,
        // so the session reference we already hold already carries the new
        // binding — pass it directly, same as the PATCH handler does.
        await writeSessionContext(session);
        await renderCanvas(session).catch((err: unknown) => {
          console.error("[harness] auto-bind canvas render failed:", err);
        });
      }
    }

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

  // Bridges the scaffold→`npm install` gap: a brand-new project renders a calm
  // "preparing" placeholder (core/canvas-render.ts's depsMissing path) because
  // its deps aren't installed yet, and neither watcher above re-fires when
  // install completes (both ignore node_modules). This one notices deps landing
  // and re-renders, so the placeholder becomes the step graph with no Retry.
  const installWatcher = new InstallWatcherManager({
    onInstalled: (harnessSessionId) => {
      const session = sessionManager.get(harnessSessionId);
      if (session && session.status !== "exited") {
        void autoRenderCanvas(session).catch((err: unknown) => {
          console.error("[harness] post-install canvas render failed:", err);
        });
      }
    },
    onTimeout: (harnessSessionId) => {
      // Install never completed within the window (offline, npm missing on
      // PATH in a stripped host). Restore the honest error panel so the user
      // regains the Retry / Ask-coding-agent actions instead of a placeholder
      // that would wait forever.
      const session = sessionManager.get(harnessSessionId);
      if (session && session.status !== "exited") {
        void renderCanvasSurfacingDepErrors(session).catch((err: unknown) => {
          console.error("[harness] install-timeout canvas render failed:", err);
        });
      }
    },
  });

  // Sessions that have already had their one-time on-start workspace rescan.
  // onStatusChange also fires on later status broadcasts (including the
  // bind/unbind frames setBoundWorkflowPath emits), so this guard keeps the
  // rescan to the FIRST transition to running — otherwise it re-fires on every
  // bind change and would re-bind a session the user just unbound.
  const rescannedOnStart = new Set<string>();

  sessionManager.onStatusChange((session) => {
    bus.publish({ type: "session.status", session });
    if (session.status === "running") {
      canvasWatcher.start(session.id, session.cwd);
      workspaceWatcher.start(session.id, session.cwd);
      // The workspace watcher captures the workflows already present at start as
      // its baseline and only fires onChange on a LATER change — so a session
      // that starts in a folder where the workflow already exists (a
      // cloned/deployed template) never triggers a rescan and never auto-binds.
      // Run the rescan ONCE on start to cover that case; the watcher covers
      // workflows that appear afterward. Auto-bind stays guarded by
      // !boundWorkflowPath, so an already-bound/resumed session is untouched.
      if (!rescannedOnStart.has(session.id)) {
        rescannedOnStart.add(session.id);
        void rescanWorkspaceForSession(session.id).catch((err: unknown) => {
          console.error("[harness] initial workspace rescan failed:", err);
        });
        // A resumed/already-bound session skips the rescan's auto-bind render
        // (guarded by !boundWorkflowPath), so render it here — a reopened
        // workflow shows its diagram on start without any manual trigger, now
        // that the empty-state render button is gone.
        if (session.boundWorkflowPath) {
          void autoRenderCanvas(session).catch((err: unknown) => {
            console.error("[harness] on-start canvas render failed:", err);
          });
        }
      }
    } else if (session.status === "exited") {
      canvasWatcher.stop(session.id);
      workspaceWatcher.stop(session.id);
      installWatcher.stop(session.id);
      portDetector.reset(session.id);
      executionDetector.reset(session.id);
      // Let a resumed session get a fresh on-start rescan.
      rescannedOnStart.delete(session.id);
      // Archive the record now the session is over, so its history survives
      // events.ndjson's retention. This path is what covers a session that
      // exited WITHOUT a SessionEnd hook (killed pty, crashed agent) and so
      // never produced the `session.end` event the ingest path archives on;
      // when both fire, the second write simply replaces the first with the
      // fuller record.
      archiveSessionRecordDetached(session.id);
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
    bus.publish({
      type: "session.activity",
      harnessSessionId,
      at: new Date().toISOString(),
    });
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
  const scanWorkflowsAndBroadcast = async (
    root: string,
  ): Promise<WorkflowInfo[]> => {
    const found = await workflowRegistry.scan(root);
    workflowsCache = await workflowRegistry.list();
    // Rewrite every open session's context file before broadcasting — a
    // listener reacting to workflows.changed (the SPA, or an agent that
    // happens to re-read the file right then) must never see the
    // notification before the file it describes is actually updated.
    await Promise.all(
      sessionManager.list().map((session) => writeSessionContext(session)),
    );
    bus.publish({ type: "workflows.changed" });
    return found;
  };

  /** Enrich only the bound workflow before a Canvas render. Canvas extraction
   *  needs the registry snapshot to resolve the binding, but its cloud badge
   *  needs the same mutable build projection exposed by /api/state. Limiting
   *  the lookup to the bound workflow avoids one remote request per linked
   *  agent on every source-triggered auto-render. */
  const canvasWorkflowsForSession = async (
    session: Pick<HarnessSession, "boundWorkflowPath">,
  ): Promise<WorkflowInfo[]> => {
    if (session.boundWorkflowPath == null) return workflowsCache;
    const boundIndex = workflowsCache.findIndex(
      (workflow) => workflow.path === session.boundWorkflowPath,
    );
    if (boundIndex === -1) return workflowsCache;
    const [enrichedBound] = await enrichWorkflows([workflowsCache[boundIndex]]);
    const workflows = [...workflowsCache];
    workflows[boundIndex] = enrichedBound;
    return workflows;
  };

  // Renders a session's bound workflow via the fully deterministic pipeline —
  // against the live workflowsCache plus the bound definition's current cloud
  // build projection; structure + derived annotations, no LLM, no user token.
  // A cheap no-op for an unbound session (the canvas router serves the empty
  // state on its own). Never throws (see core/canvas-render.ts); best-effort,
  // like every other canvas write here.
  // autoRenderCanvas is the UNPROMPTED variant (session-create/boot) that
  // won't replace a workflow's existing render with an error panel when its
  // extraction fails.
  // A depsMissing render (fresh scaffold, pre-install) shows the "preparing"
  // placeholder; arm the install watcher to re-render once deps land. Any other
  // outcome means we no longer need to wait — cancel a pending watcher (no-op
  // if none). Shared by every render trigger so the arm/disarm stays in lockstep
  // with what the pane is actually showing.
  const reactToRenderOutcome = (
    session: HarnessSession,
    outcome: Awaited<ReturnType<typeof renderCanvasForSession>>,
  ): void => {
    if (outcome.depsMissing && outcome.workflowPath) {
      installWatcher.start(session.id, outcome.workflowPath);
    } else {
      installWatcher.stop(session.id);
    }
  };
  const renderCanvas = async (session: HarnessSession): Promise<void> => {
    const outcome = await renderCanvasForSession(
      session,
      await canvasWorkflowsForSession(session),
    );
    reactToRenderOutcome(session, outcome);
  };
  const autoRenderCanvas = async (session: HarnessSession): Promise<void> => {
    const outcome = await renderCanvasForSession(
      session,
      await canvasWorkflowsForSession(session),
      { preserveExistingOnFailure: true },
    );
    reactToRenderOutcome(session, outcome);
  };
  // Used only by the install-watcher timeout: forces extraction even with deps
  // missing so the honest esbuild error panel (and its Retry/Ask actions) is
  // written instead of the placeholder. Does NOT re-arm the watcher — its
  // outcome is an extraction failure, not depsMissing.
  const renderCanvasSurfacingDepErrors = async (
    session: HarnessSession,
  ): Promise<void> => {
    const outcome = await renderCanvasForSession(
      session,
      await canvasWorkflowsForSession(session),
      { surfaceErrorOnMissingDeps: true },
    );
    reactToRenderOutcome(session, outcome);
  };

  const initialWorkflowScan = scanWorkflowsAndBroadcast(launchDir).catch(
    (err: unknown) => {
      console.error("[harness] initial agent scan failed:", err);
      return [] as WorkflowInfo[];
    },
  );

  // Boot-time retention sweep: keeps events.ndjson within the 50 MB / 30-day
  // caps even on long-lived installs. Runs through the store's exclusive queue
  // so the sweep's read→filter→rename window never races a concurrent append.
  // Fire-and-forget — a slow FS is no reason to delay server startup.
  const runNdjsonSweep = (): void => {
    void eventStore
      .runExclusive(() => sweepNdjson(eventStorePath))
      .catch((err: unknown) => {
        console.error("[harness] events.ndjson retention sweep failed:", err);
      });
  };
  runNdjsonSweep();
  const ndjsonRetentionTimer = setInterval(
    runNdjsonSweep,
    NDJSON_RETENTION_SWEEP_MS,
  );
  ndjsonRetentionTimer.unref?.();

  // One boot-time pass that archives conversations the log still holds but the
  // archive doesn't, then sweeps the archive's own caps. This is what covers the
  // two cases archiving-at-exit can't: a harness that was force-killed (no exit
  // transition, no session.end), and every session that ended before this
  // existed — whose history would otherwise vanish at its 30-day mark.
  //
  // It races the ndjson sweep queued above, and deliberately doesn't wait for
  // it: reads run outside the store's exclusive queue by design (see store.ts),
  // and either order is correct here — win the race and the record is archived
  // from bytes retention was about to delete, lose it and the record is archived
  // from what survived. Both beat not archiving it.
  //
  // Fire-and-forget: boot must not wait on it. The cost is one full index build
  // (~130 ms against a 50 MB log), which the first history open would have paid
  // anyway.
  void backfillSessionRecords({
    conversationIds: () => sessionRecordReader.conversationIds(),
    readFromEvents: (id) => sessionRecordReader.readFromEvents(id),
    archive: recordArchive,
    isLiveSession: (harnessSessionId) => {
      const session = sessionManager.get(harnessSessionId);
      return session !== undefined && session.status !== "exited";
    },
    onCapped: (remaining) => {
      console.error(
        `[harness] session record backfill hit its per-boot cap; ${remaining} conversation(s) left for the next boot`,
      );
    },
  })
    .then(() => recordArchive.sweep())
    .catch((err: unknown) => {
      console.error("[harness] session record backfill failed:", err);
    });

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

  const resolveIngestSession = (
    harnessSessionId: string,
  ): IngestSessionContext | undefined => {
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
  // JSON limit raised above express's 100 KiB default so the image-attach route
  // (base64 data URLs, up to ~13 MiB encoded) can be parsed — see
  // JSON_BODY_LIMIT_BYTES. This is the parser that actually gates every /api
  // route; the rest router mounts its own with the same limit for standalone use.
  app.use(
    "/api",
    createBootTokenMiddleware(options.bootToken),
    express.json({ limit: JSON_BODY_LIMIT_BYTES }),
  );
  app.use(
    "/api",
    createRestRouter({
      sessionManager,
      adapters,
      version: readVersion(),
      identity: identity
        ? {
            userId: identity.userId,
            tenantId: identity.tenantId,
            organizationName: identity.organizationName,
          }
        : null,
      listWorkflows: () => workflowRegistry.list().then(enrichWorkflows),
      listMacros: () => DEFAULT_MACROS,
      findWorkflow: (workflowPath) =>
        workflowsCache.find((w) => w.path === workflowPath) ?? null,
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
            console.error(
              "[harness] agent scan on session create failed:",
              err,
            );
          });
      },
      launchDir,
      defaultProjectRoot: options.projectRoot ?? launchDir,
      agentsBaseUrl: resolveAgentsBaseUrl(),
      availableHarnesses: options.availableHarnesses,
      listTasks: () => taskManager.list(),
      firstRun: options.firstRun,
      consentSource: options.consentSource,
      consentEnvReason: options.consentEnvReason,
      sessionRecords: sessionRecordReader,
      uiTrack: {
        store: eventStore,
        batcher,
        nextSeq: (sessionId) => seqCounter.next(sessionId),
        machineId,
        userId: identity?.userId ?? null,
        tenantId: identity?.tenantId ?? null,
      },
      settingsPath: statePaths.settings,
    }),
  );
  app.use(
    "/api",
    createCanvasRenderRouter({
      getSession: (harnessSessionId) => sessionManager.get(harnessSessionId),
      listWorkflows: canvasWorkflowsForSession,
      // Keep the install watcher in lockstep with what this route just put on
      // screen — without this, a depsMissing render through the POST route
      // showed the "preparing" placeholder with nothing armed to replace it.
      onOutcome: (harnessSessionId, outcome) => {
        const session = sessionManager.get(harnessSessionId);
        if (session) reactToRenderOutcome(session, outcome);
      },
    }),
  );
  // Wrap the registry so GET /api/workflows also returns enriched slugs —
  // the same enrichWorkflows pass that /api/state uses above. Only `list()` is
  // wrapped; scan/connect write through to the real registry untouched. Typed
  // as WorkflowRegistryLike so this wrapper needs no unsafe cast.
  const enrichedWorkflowRegistry: WorkflowRegistryLike = {
    list: () => workflowRegistry.list().then(enrichWorkflows),
    scan: (root: string) => workflowRegistry.scan(root),
    connectPath: (inputPath: string) => workflowRegistry.connectPath(inputPath),
  };
  app.use(
    createRunsRouter({
      // Pass the provider (not a static key) so the live-status path can refresh
      // the API key on a 401 and retry, recovering instead of locking.
      apiKey: apiKeyProvider,
      baseUrl: resolveAgentsBaseUrl(),
    }),
  );
  // The template gallery, relayed from CORE (not the agents surface) so the
  // Studio's picker and the dashboard's Template library read one catalog.
  // baseUrl omitted: the router self-defaults via resolveCoreBaseUrl().
  app.use(
    createTemplatesRouter({
      apiKey: apiKeyProvider,
    }),
  );
  // The rail's plan card, relayed from CORE for the same reason as the gallery
  // above: the key stays server-side and the card can't disagree with the
  // dashboard's billing views. baseUrl self-defaults via resolveCoreBaseUrl().
  app.use(
    createAccountRouter({
      apiKey: apiKeyProvider,
    }),
  );
  // Direct action macros (Deploy / Prod-run) — server-side, key never reaches
  // the browser, no Claude Code. Resolves a workflow :id (its path) against the
  // same live cache the rest router's findWorkflow uses.
  app.use(
    createActionsRouter({
      // Pass the provider (not a static key) so deploy/prod-run authenticate
      // with the live key and can refresh + retry on a rejected key, recovering
      // instead of locking — matching the runs router above.
      apiKey: apiKeyProvider,
      // coreBaseUrl omitted: the router self-defaults via resolveCoreBaseUrl()
      // (see actions.ts), which derives the core host from the agents env.
      resolveWorkflow: (id) => {
        const workflow = workflowsCache.find((w) => w.path === id);
        // `name` is the registry's display name — a fallback for naming an
        // agent the deploy route has to create.
        return workflow ? { path: workflow.path, name: workflow.name } : null;
      },
      // Prefer the agent's DECLARED name when deploy has to create it, read
      // from the same warm extraction cache the canvas renders from.
      resolveDefinitionName: (workflow) => resolveManifestName(workflow.path),
      // A first-time deploy writes definitionId into an existing sapiom.json,
      // which the watcher's directory-set diff cannot see — rescan that project
      // so the Draft→Deployed chip and the deploy-gated actions update.
      onLinked: async (workflow) => {
        await scanWorkflowsAndBroadcast(workflow.path);
      },
    }),
  );
  // IA-01: the session-free, workflow-keyed canvas route. Same derivation the
  // session-bound render uses, keyed by the agent's absolute path instead of a
  // session id — so a board can be read for an agent that has never hosted a
  // session. Resolution goes through the same live cache actions.ts uses, so
  // only registered agents are ever read from disk.
  app.use(
    createWorkflowGraphRouter({
      resolveWorkflow: (agentPath) =>
        workflowsCache.find((w) => resolve(w.path) === agentPath) ?? null,
    }),
  );
  // SAP-2929: the Group axis's stored arrangement, one `.sapiom/studio-rail.json`
  // per project root, plus the launch edges it seeds from. Writable roots are
  // exactly the roots the rail can SHOW — recentDirs, the configured project
  // root, and live session cwds — so the route cannot be aimed anywhere the
  // studio has not already been pointed.
  app.use(
    createStudioRailRouter({
      listKnownRoots: async () => {
        const stored = await loadSettings(statePaths.settings);
        return [
          ...stored.recentDirs,
          ...(stored.projectRoot ? [stored.projectRoot] : []),
          ...sessionManager.list().map((session) => session.cwd),
        ];
      },
      listWorkflows: () => workflowsCache,
    }),
  );
  // SAP-2930: the Project axis's drag, performed on disk. Its own guards live
  // in the module — a planner is not a permission system, so the route stats
  // the destination itself. Only a REGISTERED agent may be moved, resolved
  // through the same live cache the canvas and action routes use.
  app.use(
    createAgentMoveRouter({
      resolveAgent: (agentPath) =>
        workflowsCache.find((w) => resolve(w.path) === agentPath) ?? null,
      // Everything under the moved directory travelled with it, so every live
      // session whose cwd sat inside follows — a session left pointing at a
      // directory that no longer exists is the whole reason this remap exists.
      // Then prune the path that is gone and rescan the destination, which
      // broadcasts `workflows.changed`: the rail re-derives the tree from the
      // NEW path rather than from a stale registry row.
      onMoved: async (from, to) => {
        for (const session of sessionManager.list()) {
          const moved = remapUnder(session.cwd, from, to);
          if (moved !== session.cwd) session.cwd = moved;
          if (session.boundWorkflowPath != null) {
            session.boundWorkflowPath = remapUnder(session.boundWorkflowPath, from, to);
          }
        }
        await workflowRegistry.prune();
        await scanWorkflowsAndBroadcast(dirname(to));
      },
    }),
  );
  app.use(
    createWorkflowsRouter(enrichedWorkflowRegistry),
    createFsRouter(),
    createMacrosRouter({
      listMacros: () => DEFAULT_MACROS,
      findWorkflow: (workflowPath) =>
        workflowsCache.find((w) => w.path === workflowPath) ?? null,
      getSessionCwd: (harnessSessionId) =>
        sessionManager.get(harnessSessionId)?.cwd ?? null,
      getBoundWorkflowPath: (harnessSessionId) =>
        sessionManager.get(harnessSessionId)?.boundWorkflowPath ?? null,
      // The visualize/refresh macro forces a fresh deterministic re-render:
      // drop the bound workflow's extraction cache so a source change (new or
      // removed steps) is picked up, then re-render. Fully deterministic and
      // instant — no task, no user token, nothing to already-be-running.
      renderCanvas: async (harnessSessionId) => {
        const session = sessionManager.get(harnessSessionId);
        if (!session) return;
        if (session.boundWorkflowPath) invalidateExtractionCache(session.boundWorkflowPath);
        await renderCanvas(session);
      },
      injectInput: async (harnessSessionId, text, submit) => {
        // Two-phase write: a combined text+\r lands in Claude Code as a
        // bracketed paste and never submits.
        await sessionManager.submitInput(harnessSessionId, text, submit);
      },
      runBackgroundTask: async (
        harnessSessionId,
        macro,
        prompt,
        workflowPath,
      ) => {
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

  // In-app auth routes: POST /api/auth/start, POST /api/auth/disconnect,
  // GET /api/auth/status — reuse the CLI's performBrowserAuth flow so the
  // web app can trigger sign-in without restarting the server. Sits under /api
  // so the boot-token middleware mounted above already gates it.
  app.use(
    "/api",
    createAuthRouter({
      authState,
      apiKeyProvider,
      bus,
      environment: process.env.SAPIOM_ENVIRONMENT,
    }),
  );

  // Feeds the same seqCounter declared above — both hook POSTs and the Codex
  // transcript tailer run through processIngest(), which shares the counter.
  const ingestDeps: IngestDeps = {
    ingestToken: options.bootToken,
    normalize: normalizeHookEvent,
    resolveSession: resolveIngestSession,
    onAgentSessionResolved: (harnessSessionId, agentSessionId) => {
      // Record the agent session id — used by session-manager for resume
      // (agentSessionId feeds the --resume flag) and by the codex tailer for
      // exact-match rollout discovery.
      sessionManager.setAgentSessionId(harnessSessionId, agentSessionId);
    },
    onSessionReady: (harnessSessionId) => {
      sessionManager.setReady(harnessSessionId);
    },
    store: eventStore,
    batcher,
    enrichFromTranscript: enrichTurnCompleted,
    onNormalizedEvent: (event: AnalyticsEvent) => {
      // Synchronous and total — it counts turns and detaches any fold it
      // decides to start, so the ingest path never waits on a summary.
      rollingSummarizer.noteEvent(event);
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
        executionDetector.feed(toolInput, event.harnessSessionId);
        executionDetector.flush(event.harnessSessionId);
      }
      if (typeof toolResponseSummary === "string") {
        portDetector.feed(toolResponseSummary, event.harnessSessionId);
        portDetector.flush(event.harnessSessionId);
        executionDetector.feed(toolResponseSummary, event.harnessSessionId);
        executionDetector.flush(event.harnessSessionId);
      }
    },
    onEventPersisted: (event: AnalyticsEvent) => {
      // The normal end of a session: the SessionEnd hook's event is in the
      // store, so the archived record carries the whole conversation including
      // its `endedAt`. (The "exited" status handler archives too, for sessions
      // that never get here.)
      if (event.type === "session.end") archiveSessionRecordDetached(event.harnessSessionId);
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

  async function discoverCodexRolloutPath(
    session: HarnessSession,
  ): Promise<string | null> {
    const deadline = Date.now() + CODEX_ROLLOUT_DISCOVERY_TIMEOUT_MS;
    const sinceMs = Date.parse(session.createdAt);
    for (;;) {
      const found = await findRolloutFile(
        session.agentSessionId
          ? {
              cwd: session.cwd,
              agentSessionId: session.agentSessionId,
              homeDir: options.codexHomeDir,
            }
          : {
              cwd: session.cwd,
              sinceMs: Number.isNaN(sinceMs) ? undefined : sinceMs,
              homeDir: options.codexHomeDir,
            },
      );
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) =>
        setTimeout(resolve, CODEX_ROLLOUT_DISCOVERY_POLL_MS),
      );
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
        const body: IngestRequestBody = {
          hookEvent,
          harnessSessionId,
          payload,
        };
        void processIngest(body, ingestDeps, seqCounter).catch(
          (err: unknown) => {
            console.error("[harness] codex tailer ingest error:", err);
          },
        );
      },
      onError: (err) =>
        console.error("[harness] codex tailer parse error:", err),
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
        tailer.emitSessionEnd(
          session.exitCode != null
            ? `pty exited (code ${session.exitCode})`
            : undefined,
        );
        codexTailers.delete(session.id);
      }
    }
  });

  // Canvas is intentionally unauthenticated (see canvas.ts) — served straight
  // off the session's cwd, no boot token required.
  app.use(
    createCanvasRouter((harnessSessionId) => {
      const session = sessionManager.get(harnessSessionId);
      return session
        ? { cwd: session.cwd, boundWorkflowPath: session.boundWorkflowPath }
        : undefined;
    }),
  );

  // NOTE: mount additional routers above this line — the static/SPA fallback
  // below is a catch-all and must stay last.
  const webDir = options.webDir ?? join(packageRoot(), "dist", "web");
  app.use(createStaticRouter(webDir, options.bootToken));

  app.use(unhandledRequestErrorHandler);

  const httpServer: HttpServer = createHttpServer(app);

  const terminalWss = new WebSocketServer({ noServer: true });
  const eventsWss = new WebSocketServer({ noServer: true });
  attachWebSocketRouters(httpServer, [
    {
      path: "/ws/terminal",
      wss: terminalWss,
      onConnection: createTerminalWebSocketHandler(
        sessionManager,
        options.bootToken,
      ),
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
  const actualPort =
    typeof address === "object" && address ? address.port : options.port;
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
      installWatcher.stopAll();
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
      const killsSettled = Promise.all([
        sessionManager.killAll(),
        taskManager.killAll(),
      ]);
      let shutdownTimerHandle: ReturnType<typeof setTimeout> | undefined;
      const shutdownTimeout = new Promise<void>((resolve) => {
        shutdownTimerHandle = setTimeout(resolve, SHUTDOWN_KILL_TIMEOUT_MS);
        // Unref so the timer never keeps the event loop alive when the kill
        // path wins — mirrors SessionManager.kill()'s escalation timer pattern.
        shutdownTimerHandle.unref();
      });
      await Promise.race([killsSettled, shutdownTimeout]);
      // Clear the timer when the kill path wins (common case) so it doesn't
      // linger ref'd in the background after shutdown completes.
      if (shutdownTimerHandle !== undefined) clearTimeout(shutdownTimerHandle);
      void batcher.close();
      // wss.close() stops NEW upgrades but never terminates the connections
      // already open — and httpServer.close() then waits indefinitely for those
      // sockets to drain. The main window's live /ws/events and /ws/terminal
      // connections (plus any keep-alive HTTP socket) would therefore hang
      // close() forever, so Electron's before-quit never reaches app.quit() and
      // the process lingers as a zombie still holding the single-instance lock —
      // which blocks the next launch (it hangs on "Starting Sapiom…"). Force
      // each client shut, drop keep-alive HTTP conns, and bound the final wait
      // so shutdown always completes.
      for (const client of terminalWss.clients) client.terminate();
      for (const client of eventsWss.clients) client.terminate();
      terminalWss.close();
      eventsWss.close();
      httpServer.closeAllConnections?.();
      const HTTP_CLOSE_TIMEOUT_MS = 3_000;
      await new Promise<void>((resolve) => {
        let httpCloseTimer: ReturnType<typeof setTimeout> | undefined =
          setTimeout(() => {
            httpCloseTimer = undefined;
            resolve();
          }, HTTP_CLOSE_TIMEOUT_MS);
        httpCloseTimer.unref?.();
        httpServer.close((err) => {
          if (err) console.error("[harness] httpServer.close error:", err);
          if (httpCloseTimer !== undefined) clearTimeout(httpCloseTimer);
          resolve();
        });
      });
    },
  };
};
