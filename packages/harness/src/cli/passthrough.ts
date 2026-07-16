/**
 * CLI passthrough mode: `sapiom-harness -- claude [args...]` runs the coding
 * agent in the user's own terminal (stdio inherit — no web UI, no node-pty), while
 * the harness still does everything it does for web sessions: auth, consent,
 * config injection (hooks settings / mcp-config / skills plugin / system
 * prompt), a headless local /ingest listener, analytics normalization +
 * emission (local events.ndjson always; collector when opted in), codex
 * rollout tailing, and generated-config cleanup on exit.
 *
 * Ordering is the whole game here: every interactive / stdout step happens
 * BEFORE the child spawns — once it does, the child owns the TTY and this
 * process must write NOTHING to stdout/stderr until it exits (errors are
 * buffered and flushed after).
 */

import { spawn, type StdioOptions } from "node:child_process";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { ENV, HARNESS_PATHS, type HarnessAdapter, type HarnessKind } from "../shared/types.js";
import { expandHome } from "../core/paths.js";
import { createClaudeCodeAdapter } from "../core/adapters/claude-code.js";
import { createCodexAdapter } from "../core/adapters/codex.js";
import { CODEX_MCP_ADD_COMMAND } from "../core/adapters/codex-info.js";
import { createEventStore } from "../core/collector/store.js";
import { createHarnessEmitter } from "../core/collector/analytics-emitter.js";
import { migrateHarnessIdentity } from "../core/collector/identity-migration.js";
import { normalizeHookEvent } from "../core/collector/normalizer.js";
import { enrichTurnCompleted } from "../core/collector/transcript.js";
import { createSeqCounter } from "../core/collector/seq.js";
import { sweepNdjson } from "../core/collector/store-retention.js";
import { findRolloutFile, tailCodexRollout, type CodexTailerHandle } from "../core/collector/codex-tailer.js";
import { createDefaultBuildLaunchOpts } from "../core/inject/launch-opts.js";
import { removeGeneratedSessionDir, sweepGeneratedDirs } from "../core/inject/retention.js";
import {
  createIngestRouter,
  processIngest,
  type IngestDeps,
  type IngestRequestBody,
} from "../server/ingest.js";
import { CLI_SYSTEM_PROMPT } from "../profiles/default.js";
import { CLAUDE_INSTALL_COMMAND, CODEX_INSTALL_COMMAND } from "./doctor.js";
import { ensureAuthenticated, type HarnessIdentity } from "./auth.js";
import { ensureConsent } from "./consent.js";
import { getOrCreateMachineId } from "./machine-id.js";
import type { PassthroughInvocation } from "./passthrough-args.js";

/** Mirrors server/index.ts's codex rollout discovery bounds — see the doc
 *  comment there for why 15s/300ms. */
const CODEX_ROLLOUT_DISCOVERY_TIMEOUT_MS = 15_000;
const CODEX_ROLLOUT_DISCOVERY_POLL_MS = 300;

/**
 * Post-exit ARRIVAL grace, before tearing the ingest pipeline down. Covers
 * the two tail races a short-lived CLI has that the long-lived server
 * doesn't: a final hook POST from the dying child that hasn't reached the
 * listener yet, and rollout lines Codex appended just before exiting that
 * the tailer's next poll (300ms cadence) hasn't read yet. It is NOT a
 * completion window — once work has arrived and been scheduled, teardown
 * awaits its actual completion via the pendingIngests barrier, however long
 * transcript enrichment takes.
 */
const EXIT_DRAIN_MS = 500;

export interface RunPassthroughOverrides {
  /** Override the adapter for the invoked kind (tests inject a fixture binary). */
  adapters?: Partial<Record<HarnessKind, HarnessAdapter>>;
  /** Directory the agent runs in. Defaults to process.cwd(). */
  cwd?: string;
  /** Root directory per-session generated agent configs are written under
   *  (and removed from after exit). Defaults to HARNESS_PATHS.generated. */
  generatedRoot?: string;
  /** Local analytics ndjson sink. Defaults to HARNESS_PATHS.events. */
  eventStorePath?: string;
  /** Stable per-install id file. Defaults to HARNESS_PATHS.machineId. */
  machineIdPath?: string;
  /** Where identity migration seeds analytics.json. Defaults to
   *  `~/.sapiom/analytics.json`; tests point this into a temp dir. */
  analyticsJsonPath?: string;
  /** Skip ensureAuthenticated entirely (tests): null = unauthenticated. */
  identity?: HarnessIdentity | null;
  /** Skip ensureConsent entirely (tests). */
  telemetryOptIn?: boolean;
  /** Child stdio. Defaults to "inherit" — the child owns the terminal. */
  stdio?: StdioOptions;
  /** Home directory codex rollout discovery scans (`<home>/.codex/sessions`). */
  codexHomeDir?: string;
  rolloutDiscoveryTimeoutMs?: number;
  rolloutDiscoveryPollMs?: number;
  /** Post-exit drain window before teardown. Defaults to EXIT_DRAIN_MS. */
  exitDrainMs?: number;
  /** Injectable clock (epoch ms) for the codex rollout sinceMs baseline. */
  now?: () => number;
}

type ChildOutcome =
  | { code: number | null; signal: NodeJS.Signals | null }
  | { spawnError: Error };

// This module lives at either src/cli/passthrough.ts (tsx dev) or
// dist/cli/passthrough.js (built) — both are two directories below the
// package root, so this resolves correctly either way (same pattern as
// server/index.ts's readVersion).
function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function defaultAdapter(kind: HarnessKind): HarnessAdapter {
  return kind === "codex" ? createCodexAdapter() : createClaudeCodeAdapter();
}

function installCommand(kind: HarnessKind): string {
  return kind === "codex" ? CODEX_INSTALL_COMMAND : CLAUDE_INSTALL_COMMAND;
}

function describeExit(outcome: ChildOutcome): string {
  if ("spawnError" in outcome) return `process failed to spawn (${outcome.spawnError.message})`;
  if (outcome.code !== null) return `process exited (code ${outcome.code})`;
  return `process exited (signal ${outcome.signal ?? "unknown"})`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one passthrough session to completion. Returns the process exit code
 * the CLI should exit with (the child's own exit code; `128 + n` for a
 * signal death; 1 for doctor/spawn failures) — bin.ts assigns it to
 * `process.exitCode` so tests can call this without mutating the vitest
 * process's exit status.
 */
export async function runPassthrough(
  invocation: PassthroughInvocation,
  overrides: RunPassthroughOverrides = {},
): Promise<number> {
  const adapter = overrides.adapters?.[invocation.kind] ?? defaultAdapter(invocation.kind);
  const cwd = overrides.cwd ?? process.cwd();

  // --- 1. doctor: is the agent binary actually launchable? -----------------
  const checks = await adapter.doctor();
  const failures = checks.filter((check) => !check.ok);
  if (failures.length > 0) {
    for (const check of failures) {
      console.error(`✗ ${check.name}: ${check.detail}`);
    }
    console.error(`\nInstall ${invocation.agent} and try again:  ${installCommand(invocation.kind)}`);
    return 1;
  }

  // --- 2/3. identity: machine id, auth, consent, analytics migration -------
  // All interactive/stdout steps (browser auth, the consent readline prompt)
  // happen here, before the child takes over the terminal.
  const machineIdPath = overrides.machineIdPath ?? expandHome(HARNESS_PATHS.machineId);
  const machineId = await getOrCreateMachineId(machineIdPath);
  const identity =
    overrides.identity !== undefined
      ? overrides.identity
      : await ensureAuthenticated({ interactive: true, noAuth: invocation.noAuth });
  const telemetryOptIn =
    overrides.telemetryOptIn ?? (await ensureConsent({ noTelemetry: invocation.noTelemetry })).telemetryOptIn;
  // Same pre-emitter, one-way identity migration the server does — keeps the
  // anonymous_id join key stable for installs upgrading from harness 0.1.x.
  await migrateHarnessIdentity(machineIdPath, overrides.analyticsJsonPath);

  // --- 4. per-session inject files ------------------------------------------
  const harnessSessionId = crypto.randomUUID();
  const buildLaunchOpts = createDefaultBuildLaunchOpts(identity?.apiKey ?? null, {
    generatedRoot: overrides.generatedRoot,
    systemPrompt: CLI_SYSTEM_PROMPT,
  });
  const launchOpts = await buildLaunchOpts(harnessSessionId, { cwd, harness: invocation.kind });

  // After the child spawns, nothing may write to stdout/stderr until it
  // exits — pipeline errors are buffered here and flushed post-exit.
  const deferredErrors: string[] = [];
  const recordError = (context: string, err: unknown): void => {
    if (deferredErrors.length >= 20) return;
    deferredErrors.push(`[harness] ${context}: ${err instanceof Error ? err.message : String(err)}`);
  };

  // --- 5. headless ingest listener ------------------------------------------
  const ingestToken = crypto.randomBytes(32).toString("hex");
  const seqCounter = createSeqCounter();
  const eventStorePath = expandHome(overrides.eventStorePath ?? HARNESS_PATHS.events);
  const eventStore = createEventStore(eventStorePath);

  // Mirror the server's boot-time retention sweeps — a CLI-only install never
  // boots the web server (the only other caller), so without these nothing
  // would ever prune events.ndjson past its 50 MB / 30-day caps, or remove
  // generated/<id> dirs orphaned by crashes and force-kills. Fire-and-forget,
  // same as the server: a slow FS must not delay the spawn. The ndjson sweep
  // runs through the store's exclusive queue so it never races an append.
  void eventStore.runExclusive(() => sweepNdjson(eventStorePath)).catch((err: unknown) => {
    recordError("events.ndjson retention sweep failed", err);
  });
  void sweepGeneratedDirs({
    generatedRoot: overrides.generatedRoot,
    // This process hosts exactly one session; its freshly-written dir is
    // additionally protected by the sweep's age gate.
    isLiveSession: (id) => id === harnessSessionId,
  }).catch((err: unknown) => {
    recordError("generated-dir sweep failed", err);
  });

  const harnessVersion = readVersion();
  const batcher = createHarnessEmitter({
    telemetryOptIn,
    sdkName: "@sapiom/harness",
    sdkVersion: harnessVersion,
    apiKey: identity?.apiKey ?? null,
    // analytics-core prints its once-per-machine first-run notice on the
    // first track(), which here would land seconds AFTER spawn — into the
    // middle of the child's live TUI. Eager = print-and-mark now, while
    // stderr is still ours (we're pre-spawn). Consent-gated as always.
    eagerFirstRunNotice: true,
    context: {
      harnessVersion,
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
  });

  // Every processIngest is fire-and-forget at its source (the ingest router
  // 200s before processing; the codex tailer's poll doesn't await its
  // callbacks), so teardown needs a real completion barrier: every scheduled
  // processing promise is tracked here and drained — not merely slept past —
  // before the store barrier and the batcher's final flush. A fixed sleep
  // alone would silently drop any event whose transcript enrichment outlasts
  // the drain window.
  const pendingIngests = new Set<Promise<void>>();
  const trackIngest = (processing: Promise<void>): void => {
    const tracked: Promise<void> = processing.finally(() => {
      pendingIngests.delete(tracked);
    });
    pendingIngests.add(tracked);
  };
  const drainPendingIngests = async (): Promise<void> => {
    // Re-snapshot until quiescent: an in-flight ingest (or a tailer poll
    // that was mid-read) can schedule more work after the first snapshot.
    while (pendingIngests.size > 0) {
      await Promise.allSettled([...pendingIngests]);
    }
  };

  // Static single-session context — this process hosts exactly one session,
  // so anything POSTed under another id is unknown and dropped, same as the
  // server's registry-backed resolveSession.
  let agentSessionId: string | null = null;
  const ingestDeps: IngestDeps = {
    ingestToken,
    normalize: normalizeHookEvent,
    resolveSession: (id) =>
      id === harnessSessionId
        ? {
            harness: invocation.kind,
            userId: identity?.userId ?? null,
            tenantId: identity?.tenantId ?? null,
            machineId,
            agentSessionId,
          }
        : undefined,
    onAgentSessionResolved: (_id, resolved) => {
      agentSessionId = resolved;
    },
    store: eventStore,
    batcher,
    enrichFromTranscript: enrichTurnCompleted,
    onIngestScheduled: trackIngest,
    onError: (err) => recordError("ingest processing error", err),
    seqCounter,
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(createIngestRouter(ingestDeps));
  // Terminal error middleware. Without it, express's finalhandler
  // console.errors a full stack for any request-level error — a hook payload
  // over express.json's 1mb limit (413 PayloadTooLargeError), a truncated
  // body (400 SyntaxError) — and post-spawn that stack lands in the middle
  // of the child's live TUI. Buffer it like every other pipeline error.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    recordError("ingest http error", err);
    if (!res.headersSent) {
      const status = (err as { status?: unknown } | null)?.status;
      res.status(typeof status === "number" ? status : 400).json({ ok: false });
    }
  });
  const httpServer = createHttpServer(app);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const ingestPort = typeof address === "object" && address !== null ? address.port : 0;

  // --- 6/7. spawn spec + child env ------------------------------------------
  const spec = adapter.launch({ harnessSessionId, cwd, ...launchOpts });

  // Compose the child env exactly like SessionManager.spawn(): copy
  // process.env, apply spec.env (null = unset), then the SAPIOM_HARNESS_*
  // trio the generated emit.cjs hooks read.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(spec.env)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  env[ENV.ingestUrl] = `http://127.0.0.1:${ingestPort}/ingest`;
  env[ENV.ingestToken] = ingestToken;
  env[ENV.sessionId] = harnessSessionId;

  // --- 8. one-line notice, then hand the terminal to the child --------------
  process.stderr.write(
    `sapiom harness → ${invocation.agent} · session ${harnessSessionId.slice(0, 8)} · telemetry ${
      telemetryOptIn ? "on" : "off"
    }\n`,
  );
  if (adapter.eventSource === "transcript-tail") {
    // Codex loads MCP servers from its global config only — there's no
    // per-session --mcp-config to inject, so tell the user the one-time setup.
    process.stderr.write(`(codex has no per-session MCP config — for Sapiom tools, run once: ${CODEX_MCP_ADD_COMMAND})\n`);
  }

  // The user's own args go verbatim AFTER the injected config flags, so
  // anything they pass (e.g. --model) wins over what the harness injected.
  const child = spawn(spec.command, [...spec.args, ...invocation.agentArgs], {
    cwd: spec.cwd,
    env,
    stdio: overrides.stdio ?? "inherit",
  });

  // --- 9. signals ------------------------------------------------------------
  // Ctrl+C reaches the child directly via the shared foreground process
  // group and its TUI handles it — the parent must NOT die (or write) on
  // SIGINT while the child lives.
  const onSigint = (): void => {};
  process.on("SIGINT", onSigint);
  const onSigterm = (): void => {
    child.kill("SIGTERM");
  };
  const onSighup = (): void => {
    child.kill("SIGHUP");
  };
  process.once("SIGTERM", onSigterm);
  process.once("SIGHUP", onSighup);

  // --- 10. codex only: discover + tail the rollout file ----------------------
  let tailer: CodexTailerHandle | null = null;
  let childExited = false;
  // `codex resume` appends to an EXISTING rollout file whose session_meta
  // timestamp predates this spawn — the fresh-launch sinceMs filter would
  // reject it forever (and the session would silently produce zero
  // analytics). Match it by cwd recency instead, and tail with resume
  // semantics (skip prior history — it was recorded when it happened),
  // mirroring the server's persisted-session resume path.
  const isCodexResume = adapter.eventSource === "transcript-tail" && invocation.agentArgs[0] === "resume";
  let discoverySettled: Promise<void> | null = null;
  if (adapter.eventSource === "transcript-tail") {
    const spawnWallClock = (overrides.now ?? Date.now)();
    const discoveryTimeoutMs = overrides.rolloutDiscoveryTimeoutMs ?? CODEX_ROLLOUT_DISCOVERY_TIMEOUT_MS;
    const discoveryPollMs = overrides.rolloutDiscoveryPollMs ?? CODEX_ROLLOUT_DISCOVERY_POLL_MS;
    discoverySettled = (async () => {
      const deadline = Date.now() + discoveryTimeoutMs;
      let rolloutPath: string | null = null;
      for (;;) {
        rolloutPath = await findRolloutFile(
          agentSessionId
            ? { cwd, agentSessionId, homeDir: overrides.codexHomeDir }
            : isCodexResume
              ? { cwd, homeDir: overrides.codexHomeDir }
              : { cwd, sinceMs: spawnWallClock, homeDir: overrides.codexHomeDir },
        );
        if (rolloutPath) break;
        if (childExited || Date.now() >= deadline) {
          recordError(
            "codex tailer",
            new Error(
              `no rollout file found for session ${harnessSessionId} (cwd=${cwd}) ` +
                (childExited ? "before codex exited" : `within ${discoveryTimeoutMs}ms`),
            ),
          );
          return;
        }
        await sleep(discoveryPollMs);
      }
      // Attach even when the child has already exited (a fast-failing codex,
      // an immediate quit): the rollout content is on disk and fully readable
      // post-exit. Teardown awaits this discovery promise, gives the tailer a
      // poll to read the file, then synthesizes the SessionEnd — discarding
      // the found path here would silently drop the session's analytics.
      tailer = tailCodexRollout({
        rolloutPath,
        // Fresh launch: discovery just proved the file exists because THIS
        // spawn created it, so its entire content (session_meta included)
        // is new to us — same reasoning as server/index.ts. A resumed
        // session's rollout, by contrast, carries real prior history that
        // must stay unemitted (resume semantics: only new activity).
        startFromBeginning: !isCodexResume,
        onEvent: (hookEvent, payload) => {
          const body: IngestRequestBody = { hookEvent, harnessSessionId, payload };
          trackIngest(
            processIngest(body, ingestDeps, seqCounter).catch((err: unknown) =>
              recordError("codex tailer ingest error", err),
            ),
          );
        },
        onError: (err) => recordError("codex tailer parse error", err),
      });
    })().catch((err: unknown) => {
      recordError("codex tailer discovery error", err);
    });
  }

  // --- 11. wait for the child, then tear everything down ---------------------
  const outcome = await new Promise<ChildOutcome>((resolve) => {
    child.once("error", (spawnError) => resolve({ spawnError }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  childExited = true;

  process.off("SIGTERM", onSigterm);
  process.off("SIGHUP", onSighup);
  // The SIGINT no-op guard deliberately stays installed through teardown:
  // Claude/Codex quit on (double) Ctrl+C, and a habitual extra Ctrl+C an
  // instant after the child dies would otherwise kill the parent mid-drain —
  // losing the final telemetry flush and orphaning generated/<id> (which,
  // unlike in web mode, no later boot sweep would reach for a CLI-only
  // user). It comes off after cleanup, just before the deferred-error flush.

  // Codex: let discovery settle first — for a fast-exiting child it may
  // still be attaching the tailer for a rollout that's already on disk.
  if (discoverySettled) await discoverySettled;

  // Arrival grace, not a completion barrier: a final hook POST from the
  // dying child may still be in flight to the listener, and the codex
  // tailer's next poll (300ms cadence) may not have read the last appended
  // rollout lines yet. Completion is what drainPendingIngests below awaits.
  await sleep(overrides.exitDrainMs ?? EXIT_DRAIN_MS);
  await drainPendingIngests();
  // Widened read: the assignment happens inside the discovery IIFE above,
  // which TS's control-flow analysis can't see (it still thinks `tailer` is
  // its initial null here).
  const liveTailer = tailer as CodexTailerHandle | null;
  if (liveTailer) {
    // Codex's rollout format has no session-end line of its own — synthesize
    // the SessionEnd, then stop polling (stop() after emitSessionEnd is a
    // harmless no-op, kept for the discovery-raced case).
    liveTailer.emitSessionEnd(describeExit(outcome));
    liveTailer.stop();
    // The synthesized SessionEnd — and any straggler poll that was mid-read
    // when it fired — scheduled more ingests; drain again until quiescent so
    // nothing lands after the store barrier / batcher close below.
    await drainPendingIngests();
  }
  // Barrier: every append the pipeline already queued is on disk.
  await eventStore.runExclusive(async () => {});

  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
    // close() only refuses NEW connections — it waits indefinitely for
    // existing ones, and closeIdleConnections() skips any socket with a
    // request still in flight (which would stall this promise for up to
    // Node's default 300s requestTimeout). The only legitimate client (the
    // child's hooks) is dead, so force-close everything.
    httpServer.closeIdleConnections?.();
    httpServer.closeAllConnections?.();
  });
  // Unlike the server's fire-and-forget close, a short-lived CLI must await
  // the final flush or opted-in telemetry from this very session is lost.
  await batcher.close();

  // Only safe AFTER exit — the agent re-executes emit.cjs from this dir on
  // every hook event while it runs.
  try {
    await removeGeneratedSessionDir(harnessSessionId, { generatedRoot: overrides.generatedRoot });
  } catch (err) {
    recordError("generated-dir cleanup failed", err);
  }

  process.off("SIGINT", onSigint);

  // The child is gone — stderr is ours again.
  for (const line of deferredErrors) console.error(line);

  if ("spawnError" in outcome) {
    console.error(`[harness] failed to launch ${spec.command}: ${outcome.spawnError.message}`);
    return 1;
  }
  if (outcome.code !== null) return outcome.code;
  if (outcome.signal) return 128 + (osConstants.signals[outcome.signal] ?? 0);
  return 0;
}
