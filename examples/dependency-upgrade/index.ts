import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { CODING_RESULT_SIGNAL, type CodingResultPayload } from "@sapiom/tools";

/**
 * dependency-upgrade — a scheduled "Dependabot triage" that only opens a PR when
 * the build is green.
 *
 * Point it at an in-network repo and put it on a cron. Each run hands a coding
 * agent the job of bumping the project's dependencies inside a fresh sandbox
 * (`models.coding`), then does the part a plain bump bot skips: it re-attaches
 * that sandbox, runs the real test suite there (`sandboxes.exec`), and gates
 * everything on the result. Green builds get a model risk assessment of the
 * changed dependencies (`models.run`); red builds never push. Every run — green,
 * held, or red — archives a triage report to file storage (`fileStorage.upload`)
 * so you have a durable record of what changed and why it was or wasn't shipped.
 *
 *   plan ─▶ bump ──(pause: models.coding.result → verify)──▶ verify ─┬─▶ assess ─┬─▶ publish
 *                                                                    │           └─▶ held
 *                                                                    └─▶ rejected
 *
 *   - plan     resolves the repo + commands and validates the input.
 *   - bump     launches the coding agent on the repo, then SUSPENDS at $0 until
 *              the run finishes — coding runs are long, so the workflow pauses
 *              rather than holding a worker.
 *   - verify   re-attaches the coding run's sandbox, installs, and runs the test
 *              suite. A non-zero exit (or a failed coding run) routes to rejected.
 *   - assess   asks a model to rate the upgrade's risk from the dependency diff.
 *   - publish  pushes the bumped branch from the sandbox and archives the report.
 *   - held     risk above your auto-merge threshold — archived, not pushed.
 *   - rejected coding failed or the build is red — archived, not pushed.
 *
 * The push is the one irreversible action, so it sits behind a `dryRun` guard:
 * with `dryRun: true`, every step runs but the push and the report upload are
 * skipped, so `run_local` traces the whole graph offline for free.
 */

type RiskLevel = "low" | "medium" | "high";

/** Higher = riskier. Used to compare an assessed risk against the auto-merge bar. */
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

const DEFAULT_TASK =
  "Upgrade this project's dependencies to their latest compatible versions and " +
  "update the lockfile. Change application code only where an upgrade strictly " +
  "requires it. Keep the diff minimal and focused on the dependency bumps.";

// ──────────────────────────────────────────────────────────────── input ──
interface DependencyUpgradeInput {
  /** In-network repo slug the coding agent clones and upgrades. Required. */
  repoSlug?: string;
  /** Plain-words upgrade instruction for the coding agent (default: bump all + lockfile). */
  task?: string;
  /** Command that installs dependencies in the checkout (default `npm install`). */
  installCommand?: string;
  /** Command that runs the test suite in the checkout (default `npm test`). */
  testCommand?: string;
  /** Checkout subdirectory (relative to the sandbox workspace) to run tests in. Default: the slug. */
  workingDirectory?: string;
  /** Risk at/below which a green build auto-pushes; anything above is held. Default `medium`. */
  maxAutoRisk?: RiskLevel;
  /** Push even when the risk is above `maxAutoRisk` (skip the human hold). Default false. */
  allowRisky?: boolean;
  /** Assemble everything but skip the push + report upload, so run_local is free. */
  dryRun?: boolean;
  /** Cron cadence when deployed as a schedule — documentation only; the trigger carries it. */
  schedule?: string;
}

/** Run-scoped state; the values before the pause survive the suspend. */
interface Shared extends Record<string, unknown> {
  repoSlug: string;
  task: string;
  installCommand: string;
  testCommand: string;
  workingDirectory: string;
  maxAutoRisk: RiskLevel;
  allowRisky: boolean;
  dryRun: boolean;
  /** Sandbox the coding run left behind (captured after resume, needed to push). */
  sandboxName: string | null;
  /** Captured in `verify`, read by `assess`, `publish`, and the report. */
  codingSummary: string | null;
  diffStat: string | null;
  testTail: string | null;
  assessment: Assessment | null;
}

type Ctx = AgentExecutionContext<Shared>;

interface Assessment {
  risk: RiskLevel;
  summary: string;
  notes: string[];
}

// ──────────────────────────────────────────────────────────────── steps ──

/** Resolve the repo + commands into shared and validate the input. */
const plan = defineStep({
  name: "plan",
  next: ["bump", "rejected"],
  async run(input: DependencyUpgradeInput, ctx: Ctx) {
    const repoSlug = (input?.repoSlug ?? "").trim();
    ctx.shared.set("repoSlug", repoSlug);
    ctx.shared.set("task", input?.task?.trim() || DEFAULT_TASK);
    ctx.shared.set(
      "installCommand",
      input?.installCommand?.trim() || "npm install",
    );
    ctx.shared.set("testCommand", input?.testCommand?.trim() || "npm test");
    ctx.shared.set(
      "workingDirectory",
      input?.workingDirectory?.trim() || repoSlug,
    );
    ctx.shared.set(
      "maxAutoRisk",
      normalizeRisk(input?.maxAutoRisk) ?? "medium",
    );
    ctx.shared.set("allowRisky", input?.allowRisky === true);
    ctx.shared.set("dryRun", input?.dryRun === true);
    ctx.shared.set("sandboxName", null);
    ctx.shared.set("codingSummary", null);
    ctx.shared.set("diffStat", null);
    ctx.shared.set("testTail", null);
    ctx.shared.set("assessment", null);

    if (!repoSlug) {
      return goto("rejected", {
        reason: "no-repo",
        detail:
          "repoSlug is required — the coding agent needs a repository to upgrade.",
      });
    }
    ctx.logger.info("planning dependency upgrade", { repoSlug });
    return goto("bump", {});
  },
});

/**
 * Launch the coding agent on the repo and suspend until it finishes. The agent
 * clones the repo into a fresh sandbox at `/workspace/<slug>`, bumps the deps,
 * and leaves the checkout in the sandbox for `verify` to test.
 */
const bump = defineStep({
  name: "bump",
  next: [],
  // Async pause/resume: the launched coding run fires CODING_RESULT_SIGNAL on
  // completion (or failure), resuming this workflow at `verify` with the result.
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "verify" },
  async run(_input: unknown, ctx: Ctx) {
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const task = ctx.shared.get("task") ?? DEFAULT_TASK;
    const repo = await ctx.sapiom.repositories.get(repoSlug);
    ctx.logger.info("launching coding agent to bump dependencies", {
      repoSlug,
    });

    const handle = await ctx.sapiom.models.coding.launch({
      task,
      gitRepository: repo,
    });
    // Suspend at $0 until the coding run reaches a terminal state; the resumed
    // `verify` step receives the CodingResultPayload as its input.
    return await pauseUntilSignal(handle, { resumeStep: "verify" });
  },
});

/**
 * Re-attach the coding run's sandbox and run the real test suite in it. A failed
 * coding run, a failed install, or a non-zero test exit all route to `rejected`
 * — only a green build reaches `assess`.
 */
const verify = defineStep({
  name: "verify",
  next: ["assess", "rejected"],
  timeoutMs: 900_000,
  async run(result: CodingResultPayload, ctx: Ctx) {
    const dryRun = ctx.shared.get("dryRun") === true;
    ctx.shared.set("codingSummary", result?.summary ?? null);

    // The coding agent itself failed — there's nothing to verify.
    if (result?.status === "failed" || result?.error) {
      return goto("rejected", {
        reason: "coding-run-failed",
        detail:
          result?.error?.message ?? result?.summary ?? "coding run failed",
      });
    }

    const sandboxName = result?.executionEnvironment?.id ?? null;
    ctx.shared.set("sandboxName", sandboxName);

    if (!sandboxName) {
      // No sandbox to run tests in. Under a stubbed/dry run this is expected, so
      // synthesize a pass to trace assess → publish offline; otherwise reject.
      if (dryRun) {
        ctx.shared.set("diffStat", "(dry-run) dependency changes not computed");
        ctx.shared.set("testTail", "(dry-run) test suite not executed");
        ctx.logger.info("dry run — skipping sandbox verification");
        return goto("assess", {});
      }
      return goto("rejected", {
        reason: "no-sandbox",
        detail: "the coding run provisioned no sandbox to verify in",
      });
    }

    const installCommand = ctx.shared.get("installCommand") ?? "npm install";
    const testCommand = ctx.shared.get("testCommand") ?? "npm test";
    const cwd = ctx.shared.get("workingDirectory") ?? "";
    const box = ctx.sapiom.sandboxes.attach(sandboxName);

    // Capture what changed, for the risk assessment and the report.
    try {
      const diff = await box.exec("git --no-pager diff --stat", {
        cwd,
        timeout: 30_000,
      });
      ctx.shared.set(
        "diffStat",
        (diff.stdout || diff.stderr || "").slice(0, 4000),
      );
    } catch (err) {
      ctx.shared.set("diffStat", `diff unavailable: ${String(err)}`);
    }

    const install = await box.exec(installCommand, { cwd, timeout: 300_000 });
    if (install.exitCode !== 0) {
      ctx.shared.set("testTail", tail(install.stdout, install.stderr));
      return goto("rejected", {
        reason: "install-failed",
        detail: `\`${installCommand}\` exited ${install.exitCode}`,
      });
    }

    const test = await box.exec(testCommand, { cwd, timeout: 600_000 });
    ctx.shared.set("testTail", tail(test.stdout, test.stderr));
    if (test.exitCode !== 0) {
      return goto("rejected", {
        reason: "tests-failed",
        detail: `\`${testCommand}\` exited ${test.exitCode}`,
      });
    }

    ctx.logger.info("build green", { testCommand });
    return goto("assess", {});
  },
});

/**
 * Rate the upgrade's risk from the dependency diff and the coding summary. The
 * tests already passed; this catches the "green but scary" upgrades (a major
 * bump, a broad blast radius) and holds them for a human when they exceed your
 * auto-merge bar.
 */
const assess = defineStep({
  name: "assess",
  next: ["publish", "held"],
  timeoutMs: 60_000,
  async run(_input: unknown, ctx: Ctx) {
    const codingSummary = ctx.shared.get("codingSummary") ?? "";
    const diffStat = ctx.shared.get("diffStat") ?? "";
    const testTail = ctx.shared.get("testTail") ?? "";
    const maxAutoRisk = ctx.shared.get("maxAutoRisk") ?? "medium";
    const allowRisky = ctx.shared.get("allowRisky") === true;

    const system =
      "You are a release-risk reviewer for a dependency upgrade whose test suite ALREADY PASSED. " +
      "Judge the risk of merging it from the changed dependencies and the coding agent's summary — " +
      "weigh major-version bumps, historically breaking packages, and how broad the change is. " +
      'Reply with ONLY minified JSON: {"risk":"low|medium|high","summary":string,"notes":string[]}.';
    const prompt =
      `Coding agent summary:\n${codingSummary}\n\n` +
      `Dependency changes (git diff --stat):\n${diffStat}\n\n` +
      `Test output (tail):\n${testTail}`;

    const res = await ctx.sapiom.models.run({ prompt, system, maxTokens: 500 });
    const assessment = parseAssessment(res.output);
    ctx.shared.set("assessment", assessment);

    const held =
      RISK_ORDER[assessment.risk] > RISK_ORDER[maxAutoRisk] && !allowRisky;
    ctx.logger.info("assessed upgrade risk", {
      risk: assessment.risk,
      maxAutoRisk,
      held,
    });
    return held ? goto("held", {}) : goto("publish", {});
  },
});

/** Green + within the risk bar: push the bumped branch and archive the report. */
const publish = defineStep({
  name: "publish",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const dryRun = ctx.shared.get("dryRun") === true;
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const assessment = ctx.shared.get("assessment");
    const report = buildReport("published", ctx);
    const archived = await archiveReport(
      ctx,
      `${repoSlug}-upgrade`,
      report,
      dryRun,
    );

    // The push is the one irreversible action — skip it (and the upload) on a dry run.
    if (dryRun) {
      ctx.logger.info("dry run — skipping push", { repoSlug });
      return terminate({
        decision: "publish",
        pushed: false,
        dryRun: true,
        risk: assessment?.risk ?? null,
        reportFileId: archived.fileId,
        summary: assessment?.summary ?? null,
      });
    }

    const sandboxName = ctx.shared.get("sandboxName");
    if (!sandboxName) {
      return terminate({
        decision: "publish",
        pushed: false,
        risk: assessment?.risk ?? null,
        reportFileId: archived.fileId,
        summary: assessment?.summary ?? null,
        note: "no sandbox available to push from",
      });
    }

    const repo = await ctx.sapiom.repositories.get(repoSlug);
    const box = ctx.sapiom.sandboxes.attach(sandboxName);
    const message = truncate(
      `build(deps): ${assessment?.summary ?? "dependency upgrade"}`,
      72,
    );
    const push = await repo.pushFromSandbox(box, { message });
    ctx.logger.info("pushed dependency upgrade", {
      sha: push.sha,
      branch: push.branch,
    });
    return terminate({
      decision: "publish",
      pushed: push.pushed,
      sha: push.sha,
      branch: push.branch ?? null,
      risk: assessment?.risk ?? null,
      reportFileId: archived.fileId,
      summary: assessment?.summary ?? null,
    });
  },
});

/** Green build but the risk exceeded your auto-merge bar: archive, don't push. */
const held = defineStep({
  name: "held",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const dryRun = ctx.shared.get("dryRun") === true;
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const assessment = ctx.shared.get("assessment");
    const report = buildReport("held", ctx);
    const archived = await archiveReport(
      ctx,
      `${repoSlug}-upgrade`,
      report,
      dryRun,
    );
    ctx.logger.info("upgrade held for human review", {
      risk: assessment?.risk,
    });
    return terminate({
      decision: "hold",
      pushed: false,
      risk: assessment?.risk ?? null,
      reason: "risk above the auto-merge threshold — held for human review",
      reportFileId: archived.fileId,
      summary: assessment?.summary ?? null,
    });
  },
});

/** Coding run failed or the build is red: archive the failure, never push. */
const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(input: { reason: string; detail?: string }, ctx: Ctx) {
    const dryRun = ctx.shared.get("dryRun") === true;
    const repoSlug = ctx.shared.get("repoSlug") ?? "unknown";
    const report = buildReport("rejected", ctx, input);
    const archived = await archiveReport(
      ctx,
      `${repoSlug}-upgrade`,
      report,
      dryRun,
    );
    ctx.logger.info("upgrade rejected", { reason: input?.reason });
    return terminate({
      decision: "reject",
      pushed: false,
      reason: input?.reason ?? "unknown",
      detail: input?.detail ?? null,
      reportFileId: archived.fileId,
      testTail: ctx.shared.get("testTail") ?? null,
    });
  },
});

// ────────────────────────────────────────────────────────────── helpers ──

function normalizeRisk(value: unknown): RiskLevel | null {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Last `max` chars of the combined stdout/stderr — enough to see a failure. */
function tail(stdout: string, stderr: string, max = 2000): string {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  return combined.length > max ? combined.slice(-max) : combined;
}

/** Extract the risk assessment from the model output; default to medium on any miss. */
function parseAssessment(output: string | null): Assessment {
  const fallback: Assessment = {
    risk: "medium",
    summary: "Risk assessment unavailable; defaulted to medium.",
    notes: [],
  };
  if (!output) return fallback;
  try {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end < 0) return fallback;
    const raw = JSON.parse(output.slice(start, end + 1)) as Partial<Assessment>;
    const risk = normalizeRisk(raw.risk) ?? fallback.risk;
    return {
      risk,
      summary: typeof raw.summary === "string" ? raw.summary : fallback.summary,
      notes: Array.isArray(raw.notes)
        ? raw.notes.filter((n): n is string => typeof n === "string")
        : [],
    };
  } catch {
    return fallback;
  }
}

/** Render the triage report as markdown from the run's shared state. */
function buildReport(
  outcome: "published" | "held" | "rejected",
  ctx: Ctx,
  extra?: { reason?: string; detail?: string },
): string {
  const repoSlug = ctx.shared.get("repoSlug") ?? "unknown";
  const assessment = ctx.shared.get("assessment");
  const diffStat = ctx.shared.get("diffStat");
  const testTail = ctx.shared.get("testTail");
  const codingSummary = ctx.shared.get("codingSummary");

  const lines: string[] = [
    `# Dependency upgrade triage — ${repoSlug}`,
    "",
    `**Outcome:** ${outcome}`,
  ];
  if (assessment) lines.push(`**Risk:** ${assessment.risk}`);
  if (extra?.reason) {
    lines.push(
      `**Reason:** ${extra.reason}${extra.detail ? ` — ${extra.detail}` : ""}`,
    );
  }
  lines.push(
    "",
    "## What the agent changed",
    codingSummary || "(none reported)",
    "",
    "## Dependency diff",
    "```",
    diffStat || "(none)",
    "```",
    "",
    "## Test output (tail)",
    "```",
    testTail || "(not run)",
    "```",
  );
  if (assessment) {
    lines.push(
      "",
      "## Risk assessment",
      assessment.summary,
      ...assessment.notes.map((n) => `- ${n}`),
    );
  }
  return lines.join("\n");
}

/**
 * Archive the triage report to file storage: presign an upload URL, then PUT the
 * bytes. Skipped on a dry run so `run_local` makes no network calls; failures are
 * non-fatal (the run's decision still stands).
 */
async function archiveReport(
  ctx: Ctx,
  name: string,
  markdown: string,
  dryRun: boolean,
): Promise<{ fileId: string | null }> {
  if (dryRun) {
    ctx.logger.info("dry run — skipping report archive", { name });
    return { fileId: null };
  }
  try {
    const bytes = new TextEncoder().encode(markdown);
    const upload = await ctx.sapiom.fileStorage.upload({
      contentType: "text/markdown",
      fileName: `${name}.md`,
      fileSize: bytes.byteLength,
      visibility: "private",
    });
    await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: upload.requiredHeaders,
      body: bytes,
    });
    ctx.logger.info("archived triage report", { fileId: upload.fileId });
    return { fileId: upload.fileId };
  } catch (err) {
    ctx.logger.warn("report archive failed", { err: String(err) });
    return { fileId: null };
  }
}

export const agent = defineAgent<DependencyUpgradeInput, Shared>({
  name: "dependency-upgrade",
  entry: "plan",
  steps: { plan, bump, verify, assess, publish, held, rejected },
});
