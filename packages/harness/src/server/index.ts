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
  HarnessAdapter,
  HarnessKind,
  HarnessSession,
  WorkflowInfo,
} from "../shared/types.js";
import { SessionManager, type LaunchOptsBuilder } from "../core/session-manager.js";
import { createClaudeCodeAdapter } from "../core/adapters/claude-code.js";
import { createCodexAdapter } from "../core/adapters/codex.js";
import { WorkflowRegistry, createWorkflowsRouter } from "../core/workflow-registry.js";
import { DEFAULT_MACROS } from "../core/macros.js";
import { createEventStore } from "../core/collector/store.js";
import { CollectorBatcher } from "../core/collector/batcher.js";
import { normalizeHookEvent } from "../core/collector/normalizer.js";
import { enrichTurnCompleted } from "../core/collector/transcript.js";
import { createSeqCounter } from "../core/collector/seq.js";
import { findRolloutFile, tailCodexRollout, type CodexTailerHandle } from "../core/collector/codex-tailer.js";
import { getOrCreateMachineId } from "../cli/machine-id.js";
import type { HarnessIdentity } from "../cli/auth.js";
import { generateClaudeSettings } from "../core/inject/claude-settings.js";
import { generateMcpConfig } from "../core/inject/mcp-config.js";
import { generateSystemPromptFile } from "../core/inject/system-prompt.js";
import { CanvasWatcherManager } from "../core/canvas-watcher.js";
import { PortDetector, portFromUrl } from "../core/port-detector.js";
import { EventBus } from "../core/event-bus.js";
import { writeHarnessContext, harnessContextFileExists } from "../core/workspace-context.js";
import { createBootTokenMiddleware } from "./auth.js";
import { createRestRouter } from "./rest.js";
import { createStaticRouter } from "./static.js";
import { createTerminalWebSocketHandler } from "./terminal-ws.js";
import { createEventsWebSocketHandler } from "./events-ws.js";
import { attachWebSocketRouters } from "./ws-router.js";
import { createIngestRouter, processIngest, type IngestDeps, type IngestRequestBody, type IngestSessionContext } from "./ingest.js";
import { createCanvasRouter } from "./canvas.js";
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
  sessionsPath?: string;
  buildLaunchOpts?: LaunchOptsBuilder;
  collectorUrl?: string;
  workflowsRegistryPath?: string;
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
function createDefaultBuildLaunchOpts(apiKey: string | null): LaunchOptsBuilder {
  return async (harnessSessionId) => {
    const [settings, mcpConfigFile, systemPromptFile] = await Promise.all([
      generateClaudeSettings({ harnessSessionId }),
      generateMcpConfig(harnessSessionId, { environment: process.env.SAPIOM_ENVIRONMENT, apiKey }),
      generateSystemPromptFile(harnessSessionId),
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
  const machineId = options.machineId ?? (await getOrCreateMachineId());
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
  const workflowRegistry = new WorkflowRegistry(options.workflowsRegistryPath);
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

  const sessionManager = new SessionManager({
    adapters,
    ingestUrl: `http://${host}:${options.port}`,
    ingestToken: options.bootToken,
    collectorUrl: options.collectorUrl,
    sessionsPath: options.sessionsPath,
    buildLaunchOpts: options.buildLaunchOpts ?? createDefaultBuildLaunchOpts(identity?.apiKey ?? null),
    // Every session gets its initial harness-context.json regardless of
    // entry point (REST, autoCreateSession) — see SessionManager.create().
    writeWorkspaceContext: writeSessionContext,
    workspaceContextExists: (cwd) => harnessContextFileExists(cwd),
  });
  await sessionManager.init();

  sessionManager.onStatusChange((session) => {
    bus.publish({ type: "session.status", session });
    if (session.status === "running") {
      canvasWatcher.start(session.id, session.cwd);
    } else if (session.status === "exited") {
      canvasWatcher.stop(session.id);
      portDetector.reset(session.id);
    }
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
  const scanWorkflowsAndBroadcast = async (root: string): Promise<void> => {
    await workflowRegistry.scan(root);
    workflowsCache = await workflowRegistry.list();
    // Rewrite every open session's context file before broadcasting — a
    // listener reacting to workflows.changed (the SPA, or an agent that
    // happens to re-read the file right then) must never see the
    // notification before the file it describes is actually updated.
    await Promise.all(sessionManager.list().map((session) => writeSessionContext(session)));
    bus.publish({ type: "workflows.changed" });
  };

  scanWorkflowsAndBroadcast(launchDir).catch((err: unknown) => {
    console.error("[harness] initial workflow scan failed:", err);
  });

  const eventStore = createEventStore(options.eventStorePath);
  const batcher = new CollectorBatcher({
    machineId,
    telemetryOptIn: options.telemetryOptIn,
    collectorUrl: options.collectorUrl,
    apiKey: identity?.apiKey ?? null,
    context: {
      harnessVersion: readVersion(),
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
      onTelemetryOptInChange: (optIn) => batcher.setTelemetryOptIn(optIn),
      onSessionCreated: (cwd) => {
        scanWorkflowsAndBroadcast(cwd).catch((err: unknown) => {
          console.error("[harness] workflow scan on session create failed:", err);
        });
      },
      launchDir,
      availableHarnesses: options.availableHarnesses,
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
      injectInput: async (harnessSessionId, text, submit) => {
        // Two-phase write: a combined text+\r lands in Claude Code as a
        // bracketed paste and never submits.
        await sessionManager.submitInput(harnessSessionId, text, submit);
      },
      openUrl: async (url) => {
        await open(url);
      },
    }),
  );

  // Shared by both event sources feeding the analytics pipeline: real hook
  // POSTs (via the /ingest router below) and the Codex transcript tailer
  // (in-process, no HTTP round-trip — see startCodexTailerFor). One
  // seqCounter so a given harnessSessionId gets one consistent seq space
  // regardless of which source produced the event.
  const seqCounter = createSeqCounter();
  const ingestDeps: IngestDeps = {
    ingestToken: options.bootToken,
    normalize: normalizeHookEvent,
    resolveSession: resolveIngestSession,
    onAgentSessionResolved: (harnessSessionId, agentSessionId) => {
      sessionManager.setAgentSessionId(harnessSessionId, agentSessionId);
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
    if (session.harness !== "codex") return;
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
      return session ? { cwd: session.cwd } : undefined;
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
    sessionManager.create({ cwd: launchDir, harness }).catch((err: unknown) => {
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(workflowsCacheTimer);
        canvasWatcher.stopAll();
        for (const tailer of codexTailers.values()) tailer.stop();
        codexTailers.clear();
        // Closing the HTTP/WS server doesn't touch unrelated child processes
        // on its own — without this, every live claude/codex pty outlives
        // the harness server itself (e.g. after Ctrl+C or in a script that
        // expects the process to actually exit once close() resolves).
        sessionManager.killAll();
        void batcher.close();
        terminalWss.close();
        eventsWss.close();
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
};
