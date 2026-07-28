import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/**
 * Preview Keep-Alive — a durable cron heartbeat that RELAUNCHES a dead sandbox
 * preview, not just observes it.
 *
 * Sapiom sandbox previews are NOT durable always-on hosts: Blaxel recycles the
 * app process while the sandbox stays "running", so the preview URL 502s until a
 * human redeploys. A plain `GET /health` cron only *observes* — it never restarts
 * anything. This agent is the missing actuator: a cloud-side heartbeat that
 * actually redeploys on failure, entirely on Sapiom's durable cron.
 *
 * On each scheduled run it probes `<url><healthPath>`. If healthy, it is a
 * terminal no-op — so it never stacks a second process onto a live one (which
 * would EADDRINUSE the port). If down, it re-attaches the target sandbox and
 * calls `deployPreview` with source `fs` — rebuild + restart the code ALREADY
 * uploaded there, re-exposed at the same stable URL, no human.
 *
 * NOTE: this heals only a sandbox that still EXISTS (its uploaded code is the
 * `fs` that `deployPreview` rebuilds). A fully deleted sandbox must first be
 * re-created with a full upload deploy; after that, this keeps it up.
 *
 * ── Multi-target ──────────────────────────────────────────────────────────────
 * The target is supplied per-run via the schedule input, so ONE deployed
 * definition keeps N previews alive — one schedule each.
 *
 * Some apps need env at relaunch or they come up misconfigured (e.g. the server
 * reads DATABASE_URL/PORT). Pass literal `env`, and/or a `dbHandle` to inject
 * DATABASE_URL from a Sapiom-managed Postgres, and/or `injectEnv` to forward
 * secrets the platform put in this step's environment — never baked into the
 * schedule.
 *
 * ── With no target ────────────────────────────────────────────────────────────
 * Given no `sandboxName`, the run PROVISIONS a small demo sandbox, deploys a
 * trivial health server into it, and then heals that — the same code path, on a
 * target it owns. It never reports a healthy probe for an app it did not probe:
 * this is a monitor, and a fabricated "healthy" inverts its entire meaning.
 */

// ─────────────────────────────────────────────────────────── target config ──
interface Target {
  /** Sandbox name to attach + relaunch. */
  sandboxName: string;
  /** Base URL of the preview (health is probed at url + healthPath). */
  url: string;
  /** Health path to probe (default `/health`). */
  healthPath: string;
  /** Build command for deployPreview (default `npm install`). */
  build: string;
  /** Command that (re)starts the long-running server (default `node server.js`). */
  start: string;
  /** Port the app listens on (default 3000). */
  port: number;
  /** Literal env injected into the relaunched process. */
  env?: Record<string, string>;
  /** If set, inject DATABASE_URL from this Sapiom Postgres handle. */
  dbHandle?: string;
  /**
   * Names of env vars to forward from THIS step's environment into the relaunched
   * process. Declare each one as a required secret in `template.json` and the
   * platform injects it here at dispatch; the template never learns where it is
   * stored. Values are read at heal time and never baked into the schedule.
   */
  injectEnv?: string[];
}

const HEALTH_TIMEOUT_MS = 8000;

interface EntryInput extends Partial<Target> {
  /** Skip the probe and go straight to heal — for manual repair. */
  forceHeal?: boolean;
  /**
   * Assemble the relaunch env but do NOT call deployPreview — so `run_local`
   * traces the full heal branch offline, with no real key or network call.
   */
  dryRun?: boolean;
}

interface Shared extends Record<string, unknown> {
  target: Target;
  dryRun: boolean;
  /** Set when the run provisioned its own demo target instead of healing yours. */
  note?: string;
}

/** Name of the demo sandbox a zero-config run provisions and then heals. */
const DEMO_SANDBOX_NAME = "preview-keep-alive-demo";
/** Port the demo server listens on. */
const DEMO_PORT = 3000;
/**
 * A trivial health server, uploaded into the demo sandbox so `deployPreview` has
 * real code to rebuild and restart. Node-only, no dependencies, so `build` is a
 * no-op and the heal path is exactly the one a real target takes.
 */
const DEMO_SERVER_JS = `import { createServer } from "node:http";

const port = Number(process.env.PORT ?? ${DEMO_PORT});
createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, startedAt: new Date().toISOString() }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("preview-keep-alive demo target\\n");
}).listen(port);
console.log("demo target listening on " + port);
`;

type Ctx = AgentExecutionContext<Shared>;

/**
 * Resolve the run input into a fully-specified target. `sandboxName`, `url`, and
 * `start` come from the schedule; the rest fall back to generic defaults
 * (`/health`, `npm install`, `node server.js`, port 3000).
 */
function resolveTarget(input: EntryInput | undefined): Target {
  return {
    sandboxName: input?.sandboxName ?? "",
    url: input?.url ?? "",
    healthPath: input?.healthPath ?? "/health",
    build: input?.build ?? "npm install",
    start: input?.start ?? "node server.js",
    port: input?.port ?? 3000,
    env: input?.env,
    dbHandle: input?.dbHandle,
    injectEnv: input?.injectEnv,
  };
}

// ──────────────────────────────────────────────────────────────── steps ──

/** Probe the app; route to heal only when it is actually down. */
const check = defineStep({
  name: "check",
  next: ["healthy", "heal", "provision"],
  async run(input: EntryInput, ctx: Ctx) {
    const target = resolveTarget(input);
    ctx.shared.set("target", target);
    ctx.shared.set("dryRun", input?.dryRun === true);

    // No target to keep alive. Provision one and heal that, rather than probe an
    // empty URL and report a heal failure. Never synthesise a healthy probe: this
    // is a monitor, so a fabricated "healthy" inverts what it means.
    if (!target.sandboxName && !input?.dryRun) {
      ctx.logger.info("no sandboxName given — provisioning a demo target");
      return goto("provision", {});
    }

    if (input?.forceHeal || input?.dryRun) {
      ctx.logger.info("skipping probe — healing", {
        sandbox: target.sandboxName,
        reason: input?.dryRun ? "dryRun" : "forceHeal",
      });
      return goto("heal", { reason: input?.dryRun ? "dry-run" : "forced" });
    }

    const probeUrl = `${target.url}${target.healthPath}`;
    try {
      const res = await fetch(probeUrl, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (res.ok) {
        ctx.logger.info("app healthy", {
          sandbox: target.sandboxName,
          status: res.status,
        });
        return goto("healthy", { status: res.status });
      }
      ctx.logger.warn("app unhealthy", {
        sandbox: target.sandboxName,
        status: res.status,
      });
      return goto("heal", { reason: `status ${res.status}` });
    } catch (err) {
      // Network error / timeout == down.
      ctx.logger.warn("app probe failed", {
        sandbox: target.sandboxName,
        err: String(err),
      });
      return goto("heal", { reason: String(err) });
    }
  },
});

/**
 * Provision the demo target: a small sandbox with a trivial health server in it.
 * `heal` then rebuilds and restarts exactly that, so the zero-config run
 * exercises the real actuator against a real app it owns.
 */
const provision = defineStep({
  name: "provision",
  next: ["heal", "heal_failed"],
  async run(_input: unknown, ctx: Ctx) {
    const target = ctx.shared.get("target");
    if (!target) {
      return goto("heal_failed", {
        status: "error",
        logs: "no target resolved",
      });
    }
    try {
      // Reuse the demo sandbox across runs when it is still around — a fresh one
      // per run would leak a sandbox on every tick of a schedule.
      let box;
      try {
        await ctx.sapiom.sandboxes.get(DEMO_SANDBOX_NAME);
        box = ctx.sapiom.sandboxes.attach(DEMO_SANDBOX_NAME);
        ctx.logger.info("reusing the demo sandbox", {
          name: DEMO_SANDBOX_NAME,
        });
      } catch {
        box = await ctx.sapiom.sandboxes.create({
          name: DEMO_SANDBOX_NAME,
          ttl: "24h",
          tier: "xs",
          port: DEMO_PORT,
        });
        ctx.logger.info("created the demo sandbox", {
          name: DEMO_SANDBOX_NAME,
        });
      }
      await box.uploadFile("server.mjs", DEMO_SERVER_JS);

      ctx.shared.set("target", {
        ...target,
        sandboxName: DEMO_SANDBOX_NAME,
        healthPath: "/health",
        build: "true",
        start: "node server.mjs",
        port: DEMO_PORT,
      });
      ctx.shared.set(
        "note",
        "No `sandboxName` was given, so the run provisioned its own demo sandbox and healed that. Point `sandboxName` and `url` at your preview to keep yours alive.",
      );
      return goto("heal", { reason: "provisioned a demo target" });
    } catch (err) {
      ctx.logger.error("could not provision the demo target", {
        err: String(err),
      });
      return goto("heal_failed", { status: "error", logs: String(err) });
    }
  },
});

/** Nothing to do — the app is serving. Terminal. */
const healthy = defineStep({
  name: "healthy",
  next: [],
  terminal: true,
  async run(input: { status: number }) {
    return terminate({
      healed: false,
      healthy: true,
      status: input?.status ?? null,
    });
  },
});

/**
 * Relaunch the app in the existing sandbox. deployPreview with source `fs`
 * rebuilds + (re)starts the code already uploaded there and re-exposes the same
 * URL — so a redeploy of the app itself never has to re-run here.
 */
const heal = defineStep({
  name: "heal",
  next: ["healed", "heal_failed"],
  async run(input: { reason: string }, ctx: Ctx) {
    const target = ctx.shared.get("target");
    if (!target) {
      return goto("heal_failed", {
        status: "error",
        logs: "no target resolved",
      });
    }
    const dryRun = ctx.shared.get("dryRun") === true;
    ctx.logger.info("healing app", {
      sandbox: target.sandboxName,
      reason: input?.reason,
    });

    // Assemble relaunch env: PORT + literal env, optional DATABASE_URL from a
    // handle, plus any declared env forwarded from this step — all read at runtime.
    const env: Record<string, string> = {
      PORT: String(target.port),
      ...(target.env ?? {}),
    };
    if (target.dbHandle) {
      try {
        const db = await ctx.sapiom.database.get(target.dbHandle);
        const connectionString = db.connection?.connectionString ?? null;
        if (connectionString) env.DATABASE_URL = connectionString;
      } catch (err) {
        ctx.logger.warn("could not read db connection string", {
          handle: target.dbHandle,
          err: String(err),
        });
      }
    }
    // Forward declared secrets from the environment the platform injected them
    // into (read at runtime — never stored in the schedule or source).
    const missingEnv: string[] = [];
    for (const envVar of target.injectEnv ?? []) {
      const value = process.env[envVar];
      if (value) env[envVar] = value;
      else {
        missingEnv.push(envVar);
        ctx.logger.warn("declared env var is not set — not forwarding", {
          key: envVar,
        });
      }
    }

    // Dry run: report the assembled env keys (names only, never values) and stop
    // before any real actuation — so run_local traces this branch for free.
    if (dryRun) {
      ctx.logger.info("dry run — skipping deployPreview", {
        sandbox: target.sandboxName,
        envKeys: Object.keys(env),
      });
      return goto("healed", {
        status: "dry-run",
        url: target.url || null,
        dryRun: true,
        envKeys: Object.keys(env),
        unmet: missingEnv,
      });
    }

    try {
      const box = ctx.sapiom.sandboxes.attach(target.sandboxName);
      const res = await box.deployPreview({
        // source defaults to { kind: "fs" } — rebuild/restart the uploaded code.
        build: target.build,
        start: target.start,
        port: target.port,
        env,
      });
      ctx.logger.info("deployPreview result", {
        sandbox: target.sandboxName,
        status: res.status,
        url: res.url,
      });
      if (res.status === "failed") {
        return goto("heal_failed", { status: res.status, logs: res.logs });
      }
      return goto("healed", {
        status: res.status,
        url: res.url ?? target.url,
        envKeys: Object.keys(env),
        unmet: missingEnv,
      });
    } catch (err) {
      ctx.logger.error("deployPreview threw", {
        sandbox: target.sandboxName,
        err: String(err),
      });
      return goto("heal_failed", { status: "error", logs: String(err) });
    }
  },
});

/** Relaunch succeeded (or is unverified but exposed). Terminal. */
const healed = defineStep({
  name: "healed",
  next: [],
  terminal: true,
  async run(
    input: {
      status: string;
      url: string | null;
      dryRun?: boolean;
      envKeys?: string[];
      unmet?: string[];
    },
    ctx: Ctx,
  ) {
    const note = ctx.shared.get("note");
    const unmet = input?.unmet ?? [];
    return terminate({
      healed: true,
      dryRun: input?.dryRun ?? false,
      status: input?.status ?? null,
      url: input?.url ?? null,
      envKeys: input?.envKeys ?? null,
      ...(unmet.length ? { unmet } : {}),
      note:
        [
          note,
          unmet.length
            ? `Declared env not set, so it was not forwarded to the app: ${unmet.join(", ")}.`
            : null,
        ]
          .filter(Boolean)
          .join(" ") || undefined,
    });
  },
});

/** Relaunch failed — surface it so a run/schedule inspection shows the problem. */
const heal_failed = defineStep({
  name: "heal_failed",
  next: [],
  terminal: true,
  async run(input: { status: string; logs: string | null }, ctx: Ctx) {
    const note = ctx.shared.get("note");
    return terminate({
      healed: false,
      failed: true,
      status: input?.status ?? null,
      logs: input?.logs ?? null,
      ...(note ? { note } : {}),
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "preview-keep-alive",
  entry: "check",
  steps: { check, provision, healthy, heal, healed, heal_failed },
});
