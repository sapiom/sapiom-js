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
 * DATABASE_URL from a Sapiom-managed Postgres, and/or `vaultInject` to read
 * secrets from the vault at runtime — never baked into the schedule.
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
  /** Vault ref to read injected secrets from (paired with vaultInject). */
  vaultRef?: string;
  /**
   * Map of ENV_VAR -> vault key name. Each value is read from `vaultRef` at heal
   * time and injected into the relaunched process — so a secret the app needs
   * (e.g. its bootstrap SAPIOM_API_KEY) lives in the vault, never in the schedule.
   */
  vaultInject?: Record<string, string>;
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
}

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
    vaultRef: input?.vaultRef,
    vaultInject: input?.vaultInject,
  };
}

// ──────────────────────────────────────────────────────────────── steps ──

/** Probe the app; route to heal only when it is actually down. */
const check = defineStep({
  name: "check",
  next: ["healthy", "heal"],
  async run(input: EntryInput, ctx: Ctx) {
    const target = resolveTarget(input);
    ctx.shared.set("target", target);
    ctx.shared.set("dryRun", input?.dryRun === true);

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
    // handle, plus any vault-injected secrets — all read at runtime.
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
    // Inject secrets from the vault (value fetched at runtime — never stored in
    // the schedule or source).
    if (target.vaultRef && target.vaultInject) {
      for (const [envVar, vaultKey] of Object.entries(target.vaultInject)) {
        try {
          const secret = await ctx.sapiom.vault.get(target.vaultRef, vaultKey);
          if (secret) env[envVar] = secret;
          else
            ctx.logger.warn("vault key missing/empty", {
              ref: target.vaultRef,
              key: vaultKey,
            });
        } catch (err) {
          ctx.logger.warn("vault read failed", {
            ref: target.vaultRef,
            key: vaultKey,
            err: String(err),
          });
        }
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
  async run(input: {
    status: string;
    url: string | null;
    dryRun?: boolean;
    envKeys?: string[];
  }) {
    return terminate({
      healed: true,
      dryRun: input?.dryRun ?? false,
      status: input?.status ?? null,
      url: input?.url ?? null,
      envKeys: input?.envKeys ?? null,
    });
  },
});

/** Relaunch failed — surface it so a run/schedule inspection shows the problem. */
const heal_failed = defineStep({
  name: "heal_failed",
  next: [],
  terminal: true,
  async run(input: { status: string; logs: string | null }) {
    return terminate({
      healed: false,
      failed: true,
      status: input?.status ?? null,
      logs: input?.logs ?? null,
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "preview-keep-alive",
  entry: "check",
  steps: { check, healthy, heal, healed, heal_failed },
});
