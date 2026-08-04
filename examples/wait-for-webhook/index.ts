import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { z } from "zod/v4";

/**
 * Wait-for-Webhook — durable pause/resume around any slow external callback.
 *
 * The sharpest showcase of the platform's durability differentiator, and the
 * direct counter to "agents are too expensive to run": `kickoff` starts a slow
 * external async job and registers a resume contract, then the run **suspends
 * indefinitely at $0** via `pauseUntilSignal` — no polling loop, no held worker,
 * no billed idle time. It resumes only when the external world fires the signal
 * (a webhook/callback), delivering a result payload that becomes the resumed
 * step's input. `decide` summarizes that payload with a model and branches to
 * `accept` or `reject`.
 *
 *   kickoff ──(pause: wait for `SIGNAL`, $0 while idle)──▶ decide ─┬─▶ accept
 *                                                                  └─▶ reject
 *
 * Resume contract: `kickoff` registers `{ executionId, signal, correlationId }`
 * with the external job and pauses; the external caller fires that signal (in
 * dev, via local MCP `sapiom_dev_agents_signal` — see README). The
 * resumed `decide` step's input IS the callback payload; everything else survives
 * the pause in `ctx.shared`.
 *
 * Offline: with no `CALLBACK_REGISTER_URL` configured (or `DRY_RUN` set), no
 * external job is registered — so nothing would ever fire the callback, and the
 * run does NOT pause. It goes straight to `decide` on an empty payload and says
 * so in its output. The durable pause is what a configured run does.
 *
 * Deadline: the pause waits **indefinitely** by default — the $0-forever
 * guarantee. A callback that never arrives would otherwise park the run for
 * good, so set `config.CALLBACK_TIMEOUT_MS` to a positive number of
 * milliseconds to cap the wait. If no callback fires within that window, the
 * engine's deadline sweep ends the run with a pause-timeout failure — an honest
 * terminal state ("no callback within N") instead of a permanently parked run.
 * Unset/blank keeps the indefinite wait.
 */

/** String-only config bag (matches how templates receive their `config`). */
type Config = Record<string, string>;

/** The run input: parameters for the external job, plus optional config. */
interface WaitForWebhookInput {
  /** Arbitrary parameters handed to the external async job. */
  job?: Record<string, unknown>;
  /**
   * Config bag. `CALLBACK_REGISTER_URL` (+ optional `CALLBACK_REGISTER_KEY`)
   * points at the external job — absent (or `DRY_RUN`) ⇒ skip registration. Optional
   * `CALLBACK_TIMEOUT_MS` caps the wait (see `parseTimeoutMs`); absent ⇒ waits
   * indefinitely at $0.
   */
  config?: Config;
}

/**
 * The callback body delivered by the external webhook — it becomes `decide`'s
 * input verbatim. Intentionally open: a real job returns whatever it returns.
 */
interface CallbackPayload {
  /** Job-defined outcome, e.g. `"succeeded"` / `"failed"`. Optional. */
  status?: string;
  /** The job's result body, whatever shape it has. */
  result?: unknown;
  [key: string]: unknown;
}

interface Decision {
  decision: "accept" | "reject";
  summary: string;
  reasons: string[];
}

/** Pre-pause state that must survive the suspend, read back after resume. */
interface Shared extends Record<string, unknown> {
  config: Config;
  job: Record<string, unknown>;
  correlationId: string;
  jobId: string;
  /** Set when no external job was registered, so no real callback ever arrived. */
  note?: string;
}

/** The named signal the external callback fires to resume this run. */
const SIGNAL = "webhook.callback";

// ---- helpers ---------------------------------------------------------------
function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing shared state: ${name}`);
  return value;
}

/**
 * True when there's no live external dependency to talk to — no register URL, or
 * `DRY_RUN` explicitly set. Lets `run_local` exercise the full control flow
 * while skipping the authored registration call.
 */
function isDryRun(config: Config): boolean {
  const flag = (config.DRY_RUN ?? "").toLowerCase();
  return flag === "1" || flag === "true" || !config.CALLBACK_REGISTER_URL;
}

/**
 * Optional deadline for the pause, in milliseconds, from
 * `config.CALLBACK_TIMEOUT_MS`. Absent/blank ⇒ `undefined` (wait indefinitely at
 * $0, the default). A positive integer caps the wait: with no callback inside it,
 * the engine's deadline sweep terminates the run with a pause-timeout failure
 * rather than parking it forever. A non-positive or unparseable value is
 * rejected — silently ignoring a cap would reintroduce the forever-park bug it's
 * meant to prevent, so a misconfigured deadline fails loudly at `kickoff`.
 */
function parseTimeoutMs(config: Config): number | undefined {
  const raw = (config.CALLBACK_TIMEOUT_MS ?? "").trim();
  if (!raw) return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `invalid CALLBACK_TIMEOUT_MS "${raw}": expected a positive number of milliseconds`,
    );
  }
  return Math.floor(ms);
}

/**
 * Register the resume contract with the external job and kick it off. The job is
 * expected to fire `SIGNAL` (with our `correlationId`) once its result is ready.
 */
async function registerJob(
  config: Config,
  body: { resume: unknown; job: Record<string, unknown> },
): Promise<{ jobId: string }> {
  const url = (config.CALLBACK_REGISTER_URL ?? "").replace(/\/$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.CALLBACK_REGISTER_KEY)
    headers.authorization = `Bearer ${config.CALLBACK_REGISTER_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `register failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  const parsed = (text ? JSON.parse(text) : {}) as { jobId?: string };
  return { jobId: parsed.jobId ?? "unknown" };
}

// ---- steps -----------------------------------------------------------------
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. Both fields are optional: absent
 * `config` (or `DRY_RUN`) skips registration; a `CALLBACK_TIMEOUT_MS` caps the wait.
 */
const entryInput = z.object({
  job: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arbitrary parameters handed to the external async job."),
  config: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Config bag. CALLBACK_REGISTER_URL points at the external job; CALLBACK_TIMEOUT_MS caps the wait.",
    ),
});

const kickoff = defineStep({
  name: "kickoff",
  inputSchema: entryInput,
  next: ["decide"],
  // Static graph edge: on `SIGNAL`, resume at `decide`. Must match the directive.
  pause: { signal: SIGNAL, resumeStep: "decide" },
  async run(input: WaitForWebhookInput, ctx: AgentExecutionContext<Shared>) {
    const config = input.config ?? {};
    const job = input.job ?? {};
    // Validate the optional deadline up front — before we register any external
    // job — so a bad `CALLBACK_TIMEOUT_MS` fails fast instead of after kickoff.
    const timeoutMs = parseTimeoutMs(config);
    // Everything set before the pause survives in ctx.shared and is read back
    // in `decide`; the resumed step's *input* is the callback payload itself.
    ctx.shared.set("config", config);
    ctx.shared.set("job", job);
    ctx.shared.set("correlationId", ctx.executionId);

    // Tell the external job how to resume this exact run when its result is ready.
    const resume = {
      executionId: ctx.executionId,
      signal: SIGNAL,
      correlationId: ctx.executionId,
    };

    if (isDryRun(config)) {
      // No live endpoint, so no external job was registered and nothing will ever
      // fire the callback. Pausing here would suspend the run forever. Take the
      // decide branch on an empty payload instead — a real model call over a
      // callback that says, honestly, that no callback arrived.
      ctx.shared.set("jobId", "not-registered");
      ctx.shared.set(
        "note",
        "No `CALLBACK_REGISTER_URL` is configured, so no external job was started and no callback arrived — the decision below was made on an empty payload. Set the register URL to wait on a real job.",
      );
      ctx.logger.info(
        "no register URL — deciding on an empty payload instead of pausing",
        { correlationId: ctx.executionId },
      );
      return goto("decide", {} as CallbackPayload);
    } else {
      const { jobId } = await registerJob(config, { resume, job });
      ctx.shared.set("jobId", jobId);
      ctx.logger.info("external job started; pausing for callback", {
        jobId,
        correlationId: ctx.executionId,
        timeoutMs: timeoutMs ?? null,
      });
    }

    // Suspend at $0 until the external world fires SIGNAL for this correlationId.
    // With `timeoutMs` set, the engine's deadline sweep instead fails the run if
    // no callback arrives in time — an honest terminal state, not a forever park.
    // Omitted ⇒ the default indefinite wait.
    return pauseUntilSignal({
      signal: SIGNAL,
      resumeStep: "decide",
      correlationId: ctx.executionId,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  },
});

const decide = defineStep({
  name: "decide",
  next: ["accept", "reject"],
  // `payload` IS the callback body delivered by the resume signal.
  async run(payload: CallbackPayload, ctx: AgentExecutionContext<Shared>) {
    // Pre-pause state survived the suspend and is read back here.
    const job = must(ctx.shared.get("job"), "job");

    const system =
      "You are reviewing the result of a slow external async job that was delivered via a webhook callback. " +
      "Summarize the result and decide whether to ACCEPT it (the job succeeded and the result looks complete " +
      "and usable) or REJECT it (the job failed, is incomplete, or the result is problematic). " +
      'Reply with ONLY minified JSON: {"decision":"accept|reject","summary":string,"reasons":string[]}.';
    const prompt =
      `Original job request:\n${JSON.stringify(job)}\n\n` +
      `Callback payload:\n${JSON.stringify(payload)}`;

    const res = await ctx.sapiom.models.run({ prompt, system, maxTokens: 400 });
    const decision = parseDecision(res.output, payload);
    ctx.shared.set("decision", decision);
    ctx.logger.info("callback decided", {
      decision: decision.decision,
      reasons: decision.reasons.length,
    });

    return decision.decision === "accept"
      ? goto("accept", {})
      : goto("reject", {});
  },
});

const accept = defineStep({
  name: "accept",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const decision = must(ctx.shared.get("decision"), "decision") as Decision;
    const jobId = must(ctx.shared.get("jobId"), "jobId");
    const note = ctx.shared.get("note");
    ctx.logger.info("accepted", { jobId });
    return terminate({
      jobId,
      decision: "accept",
      summary: decision.summary,
      ...(note ? { unmet: ["CALLBACK_REGISTER_URL"], note } : {}),
    });
  },
});

const reject = defineStep({
  name: "reject",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const decision = must(ctx.shared.get("decision"), "decision") as Decision;
    const jobId = must(ctx.shared.get("jobId"), "jobId");
    ctx.logger.info("rejected", { jobId, reasons: decision.reasons });
    return terminate({
      jobId,
      decision: "reject",
      summary: decision.summary,
      reasons: decision.reasons,
      ...(ctx.shared.get("note")
        ? {
            unmet: ["CALLBACK_REGISTER_URL"],
            note: ctx.shared.get("note"),
          }
        : {}),
    });
  },
});

// ---- parsing ---------------------------------------------------------------
/** Extract the decision from the model output; fall back to the payload status. */
function parseDecision(
  output: string | null,
  payload: CallbackPayload,
): Decision {
  const status = (payload.status ?? "").toLowerCase();
  const looksFailed = [
    "error",
    "failed",
    "fail",
    "rejected",
    "cancelled",
    "canceled",
  ].includes(status);
  const fallback: Decision = {
    decision: looksFailed ? "reject" : "accept",
    summary: `Callback status "${payload.status ?? "unknown"}"; model summary unavailable (defaulted to status).`,
    reasons: looksFailed ? [`status="${payload.status}"`] : [],
  };
  if (!output) return fallback;
  try {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end < 0) return fallback;
    const raw = JSON.parse(output.slice(start, end + 1)) as Partial<Decision>;
    const decision =
      raw.decision === "accept" || raw.decision === "reject"
        ? raw.decision
        : fallback.decision;
    return {
      decision,
      summary: typeof raw.summary === "string" ? raw.summary : fallback.summary,
      reasons: Array.isArray(raw.reasons)
        ? raw.reasons.filter((r): r is string => typeof r === "string")
        : [],
    };
  } catch {
    return fallback;
  }
}

export const agent = defineAgent<WaitForWebhookInput, Shared>({
  name: "wait-for-webhook",
  entry: "kickoff",
  steps: { kickoff, decide, accept, reject },
});
