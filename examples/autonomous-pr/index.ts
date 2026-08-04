import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { CODING_RESULT_SIGNAL, type CodingResultPayload } from "@sapiom/tools";
import { z } from "zod/v4";
import { SEED_PREAMBLE } from "./seed.js";

/**
 * autonomous-pr — point it at a repo; a coding agent picks up a task, writes
 * the code, runs your checks, and pushes a branch carrying its own self-review.
 *
 * Fuses `dependency-upgrade` (coding agent → sandbox re-attach → real checks →
 * gate the push on green) with `pr-review-bot` (a second model reading a diff
 * to write a structured review) into one end-to-end "do the work" agent rather
 * than a narrow bump or a read-only review.
 *
 *   plan ─▶ implement ──(pause: models.coding.result → verify)──▶ verify ─┬─▶ push ─▶ review ─▶ summary
 *                                                                          └─▶ rejected
 *
 *   - plan       resolves the repo. Given `repoSlug`, it must already exist —
 *                a repository is a RESOURCE. Given none, it self-provisions a
 *                small scratch repo so a zero-input run still has something
 *                real to work in (never a plausible-looking name; an actually
 *                created one).
 *   - implement  launches a coding agent (`models.coding`) on the repo, then
 *                SUSPENDS at $0 until it finishes — coding runs are long. On
 *                the scratch repo it first seeds a tiny `AUTHORING.md` and two
 *                minimal examples (the repo is empty, so this is the same
 *                agent turn as the task itself, not a second billed run), then
 *                does the task: add one more example that follows it. The
 *                agent only edits files — it is never asked to run git.
 *   - verify     re-attaches that sandbox and runs the repo's own install +
 *                check commands over the agent's (still uncommitted) changes.
 *                A failed coding run or a red check routes to `rejected`;
 *                nothing is branched or pushed.
 *   - push       creates a fresh branch and pushes the agent's changes to it
 *                (`repositories.pushFromSandbox`, which commits whatever is
 *                pending and pushes) — the platform's git host has no hosted
 *                pull-request object yet, so the pushed branch is what you
 *                review.
 *   - review     a second model (`models.run`) reads the diff and the coding
 *                agent's own notes and writes a short self-review: a verdict,
 *                a summary, and what it would flag.
 *   - summary    returns everything: the repo, the branch, the sha, and the
 *                self-review.
 *   - rejected   no repo, a failed coding run, or a red check — archived only
 *                in the run's own output; nothing is branched or pushed.
 *
 * The push is the one irreversible step, so it only happens after `verify`'s
 * checks are green — same gate `dependency-upgrade` uses for its push.
 */

const DEFAULT_TASK =
  "Read this repo's AUTHORING.md (or nearest CONTRIBUTING/README) and add ONE " +
  "new example directory that follows its conventions exactly — its own " +
  "runnable code plus its manifest. Keep the change small, self-contained, " +
  "and covered by the repo's own checks.";

// The scratch repo self-provisioned on a zero-input run starts out empty, so
// "add a new example following this repo's conventions" is meaningless until
// something establishes those conventions. `SEED_PREAMBLE` (imported above,
// from `./seed.ts`) is handed to the SAME coding-agent run as exact file
// content to write before the real task — a tiny, self-contained slice of a
// real examples repo, not a copy of this one. It lives in its own module
// because its literal text contains `entry:` / `defineAgent` / `defineStep` —
// tokens a static scan of this file (`examples-entry-schema-check`) looks for
// to find *this* template's own entry step; left inline, it would find the
// seeded example's instead. Never applied to a `repoSlug` the caller
// supplied — a real repo's conventions are whatever it already has.

// ──────────────────────────────────────────────────────────────── input ──
interface AutonomousPrInput {
  /** In-network repo the coding agent works in. Absent ⇒ self-provisions a scratch repo. */
  repoSlug?: string;
  /** Plain-words task for the coding agent (default: add an example following AUTHORING.md). */
  task?: string;
  /** Command that installs dependencies in the checkout (default `npm install`). */
  installCommand?: string;
  /** Command that must pass before anything is pushed (default `npm run typecheck`). */
  checkCommand?: string;
}

type Mode = "byo" | "self-provisioned";

interface Review {
  verdict: "approve" | "comment" | "request_changes";
  summary: string;
  notes: string[];
}

/** Run-scoped state; the values before the pause survive the suspend. */
interface Shared extends Record<string, unknown> {
  mode: Mode;
  repoSlug: string;
  cloneUrl: string;
  task: string;
  installCommand: string;
  checkCommand: string;
  branchName: string;
  sandboxName: string | null;
  /** The sandbox dir the checkout was actually verified in (never assumed). */
  checkoutCwd: string | null;
  codingSummary: string | null;
  diffStat: string | null;
  checkTail: string | null;
  pushed: boolean;
  pushSha: string | null;
  pushBranch: string | null;
  review: Review | null;
}

type Ctx = AgentExecutionContext<Shared>;

// ──────────────────────────────────────────────────────────────── steps ──

/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `repoSlug` has no default on
 * purpose — a repository must exist, so an empty value means "provision one",
 * not "guess a plausible one".
 */
const entryInput = z.object({
  repoSlug: z
    .string()
    .optional()
    .describe(
      "In-network repo the coding agent works in. Absent ⇒ self-provisions a scratch repo.",
    ),
  task: z
    .string()
    .default(DEFAULT_TASK)
    .describe("Plain-words task for the coding agent."),
  installCommand: z
    .string()
    .default("npm install")
    .describe("Command that installs dependencies in the checkout."),
  checkCommand: z
    .string()
    .default("npm run typecheck")
    .describe("Command that must pass before anything is pushed."),
});

const plan = defineStep({
  name: "plan",
  inputSchema: entryInput,
  next: ["implement", "rejected"],
  async run(input: AutonomousPrInput, ctx: Ctx) {
    const task = input?.task?.trim() || DEFAULT_TASK;
    const installCommand = input?.installCommand?.trim() || "npm install";
    const checkCommand = input?.checkCommand?.trim() || "npm run typecheck";
    ctx.shared.set("task", task);
    ctx.shared.set("installCommand", installCommand);
    ctx.shared.set("checkCommand", checkCommand);
    ctx.shared.set("branchName", `autonomous-pr/${slugify(ctx.executionId)}`);
    ctx.shared.set("sandboxName", null);
    ctx.shared.set("checkoutCwd", null);
    ctx.shared.set("codingSummary", null);
    ctx.shared.set("diffStat", null);
    ctx.shared.set("checkTail", null);
    ctx.shared.set("pushed", false);
    ctx.shared.set("pushSha", null);
    ctx.shared.set("pushBranch", null);
    ctx.shared.set("review", null);

    const requestedSlug = (input?.repoSlug ?? "").trim();

    if (requestedSlug) {
      // A repository is a RESOURCE: it has to exist. There is deliberately no
      // default slug — naming a plausible one (`my-app`) turns a clean
      // rejection into a 404 mid-run.
      try {
        const repo = await ctx.sapiom.repositories.get(requestedSlug);
        ctx.shared.set("mode", "byo");
        ctx.shared.set("repoSlug", repo.slug);
        ctx.shared.set("cloneUrl", repo.cloneUrl);
        ctx.logger.info("planning autonomous PR against an existing repo", {
          repoSlug: repo.slug,
        });
        return goto("implement", {});
      } catch (err) {
        return goto("rejected", {
          reason: "repo-not-found",
          detail:
            `No in-network repository named \`${requestedSlug}\` was found, ` +
            `so nothing was cloned or changed (${String(err)}).`,
          unmet: ["repoSlug"],
        });
      }
    }

    // No repo named: self-provision a small scratch repo so a zero-input run
    // still has something real to work in.
    const demoSlug = `autonomous-pr-demo-${slugify(ctx.executionId)}`;
    try {
      const repo = await ctx.sapiom.repositories.create(demoSlug);
      ctx.shared.set("mode", "self-provisioned");
      ctx.shared.set("repoSlug", repo.slug);
      ctx.shared.set("cloneUrl", repo.cloneUrl);
      ctx.logger.info("provisioned a scratch demo repo", {
        repoSlug: repo.slug,
      });
      return goto("implement", {});
    } catch (err) {
      return goto("rejected", {
        reason: "provision-failed",
        detail:
          "Could not provision a scratch demo repository, so there was " +
          `nothing to work in (${String(err)}).`,
      });
    }
  },
});

/**
 * Launch the coding agent on the repo and suspend until it finishes. It only
 * edits files — never asked to run git — so the branch and the push stay in
 * `verify` / `push`, exact and repeatable rather than depending on the agent.
 */
const implement = defineStep({
  name: "implement",
  next: [],
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "verify" },
  async run(_input: unknown, ctx: Ctx) {
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const mode = ctx.shared.get("mode") ?? "byo";
    const task = ctx.shared.get("task") ?? DEFAULT_TASK;
    const repo = await ctx.sapiom.repositories.get(repoSlug);

    const fullTask =
      (mode === "self-provisioned" ? SEED_PREAMBLE : "") + `Task: ${task}`;

    ctx.logger.info("launching coding agent", { repoSlug, mode });
    const handle = await ctx.sapiom.models.coding.launch({
      task: fullTask,
      gitRepository: repo,
    });
    return await pauseUntilSignal(handle, { resumeStep: "verify" });
  },
});

/**
 * Re-attach the coding run's sandbox and run the repo's own install + check
 * commands over the agent's (still uncommitted) changes. Only a green check
 * reaches `push`.
 */
const verify = defineStep({
  name: "verify",
  next: ["push", "rejected"],
  timeoutMs: 900_000,
  async run(result: CodingResultPayload, ctx: Ctx) {
    const codingSummary = result?.summary ?? null;
    ctx.shared.set("codingSummary", codingSummary);

    // The coding agent itself failed — there's nothing to check.
    if (result?.status === "failed" || result?.error) {
      return goto("rejected", {
        reason: "coding-run-failed",
        detail: result?.error?.message ?? codingSummary ?? "coding run failed",
      });
    }

    const sandboxName = result?.executionEnvironment?.id ?? null;
    ctx.shared.set("sandboxName", sandboxName);
    if (!sandboxName) {
      return goto("rejected", {
        reason: "no-sandbox",
        detail: "the coding run provisioned no sandbox to check in",
      });
    }

    const installCommand = ctx.shared.get("installCommand") ?? "npm install";
    const checkCommand = ctx.shared.get("checkCommand") ?? "npm run typecheck";
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const box = ctx.sapiom.sandboxes.attach(sandboxName);

    // `gitRepository` is DOCUMENTED to clone into the sandbox at
    // `/workspace/<slug>`, but that's the platform's word, not a guarantee
    // this run kept — verify it before trusting it, and if it doesn't hold,
    // locate the checkout instead of silently running every command in the
    // wrong directory.
    const resolved = await resolveCheckoutCwd(box, repoSlug, ctx);
    if (!resolved.cwd) {
      ctx.shared.set("checkTail", resolved.probe);
      return goto("rejected", {
        reason: "checkout-not-found",
        detail:
          `Could not find the coding run's checkout in sandbox \`${sandboxName}\` ` +
          `(expected \`/workspace/${repoSlug}\`): ${resolved.probe}`,
      });
    }
    const cwd = resolved.cwd;
    ctx.shared.set("checkoutCwd", cwd);

    // Capture what changed, for the self-review — uncommitted, so a plain
    // `diff --stat` (no ref range) is exactly the agent's working-tree edits.
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
      const installTail = tail(install.stdout, install.stderr);
      ctx.shared.set("checkTail", installTail);
      return goto("rejected", {
        reason: "install-failed",
        // The seeded `package.json` pins `@sapiom/agent`/`@sapiom/tools` to
        // ranges confirmed resolvable on the public npm registry — if this
        // is a resolution error rather than a real dependency problem, the
        // sandbox's npm is very likely pointed somewhere else. `installTail`
        // (echoed below) carries npm's own error, so this isn't a guess.
        detail:
          `\`${installCommand}\` exited ${install.exitCode} in \`${cwd}\` ` +
          "(if this is a package-resolution error rather than a real " +
          "dependency problem, check the sandbox's npm registry — the " +
          "seeded deps are pinned to versions published on the public " +
          `npm registry). Install output:\n${installTail}`,
      });
    }

    const check = await box.exec(checkCommand, { cwd, timeout: 300_000 });
    ctx.shared.set("checkTail", tail(check.stdout, check.stderr));
    if (check.exitCode !== 0) {
      return goto("rejected", {
        reason: "check-failed",
        detail: `\`${checkCommand}\` exited ${check.exitCode}`,
      });
    }

    ctx.logger.info("check green", { checkCommand });
    return goto("push", {});
  },
});

/**
 * Create a fresh branch ourselves (the agent never ran git) and push the
 * agent's changes to it. `pushFromSandbox` commits whatever is pending and
 * pushes the currently checked-out branch — the reviewable unit, since this
 * git host has no hosted pull-request object yet.
 */
const push = defineStep({
  name: "push",
  next: ["review"],
  async run(_input: unknown, ctx: Ctx) {
    const sandboxName = ctx.shared.get("sandboxName") ?? "";
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const branchName = ctx.shared.get("branchName") ?? "autonomous-pr/task";
    const task = ctx.shared.get("task") ?? DEFAULT_TASK;
    const box = ctx.sapiom.sandboxes.attach(sandboxName);

    // `verify` already found and confirmed the checkout's real directory —
    // reuse it rather than re-assume `/workspace/<slug>`, so the branch this
    // creates is the SAME checkout `verify` just ran the checks against.
    const cwd = ctx.shared.get("checkoutCwd") ?? `/workspace/${repoSlug}`;
    await box.exec(`git checkout -b ${branchName}`, {
      cwd,
      timeout: 30_000,
    });

    const repo = await ctx.sapiom.repositories.get(repoSlug);
    const message = truncate(`feat: ${task}`, 72);
    // Pass the confirmed working directory explicitly rather than relying on
    // `pushFromSandbox`'s own `/workspace/<slug>` default — the same
    // directory the branch above was just created in.
    const result = await repo.pushFromSandbox(box, {
      message,
      workingDirectory: cwd,
    });

    ctx.shared.set("pushed", result.pushed);
    ctx.shared.set("pushSha", result.sha);
    ctx.shared.set("pushBranch", result.branch ?? branchName);
    ctx.logger.info("pushed branch", {
      branch: result.branch ?? branchName,
      sha: result.sha,
    });
    return goto("review", {});
  },
});

/**
 * A second model reads the diff and the coding agent's own notes and writes a
 * short self-review — a verdict, a summary, and what it would flag. Purely
 * informational: it never blocks the push, which already happened.
 */
const review = defineStep({
  name: "review",
  next: ["summary"],
  timeoutMs: 60_000,
  async run(_input: unknown, ctx: Ctx) {
    const diffStat = ctx.shared.get("diffStat") ?? "";
    const checkTail = ctx.shared.get("checkTail") ?? "";
    const codingSummary = ctx.shared.get("codingSummary") ?? "";
    const task = ctx.shared.get("task") ?? DEFAULT_TASK;

    const system =
      "You are reviewing your own pull request before a human sees it. The " +
      "checks already passed. Judge whether the change actually does the " +
      "stated task, is scoped tightly to it, and reads like something you'd " +
      'approve. Reply with ONLY minified JSON: {"verdict":"approve|comment|' +
      'request_changes","summary":string,"notes":string[]}.';
    const prompt =
      `Task:\n${task}\n\n` +
      `Coding agent's own summary:\n${codingSummary}\n\n` +
      `Diff (stat):\n${diffStat}\n\n` +
      `Check output (tail):\n${checkTail}`;

    const res = await ctx.sapiom.models.run({ prompt, system, maxTokens: 500 });
    const rev = parseReview(res.output);
    ctx.shared.set("review", rev);
    ctx.logger.info("self-review complete", { verdict: rev.verdict });
    return goto("summary", {});
  },
});

/** Green, pushed, and self-reviewed: return everything. */
const summary = defineStep({
  name: "summary",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const mode = ctx.shared.get("mode") ?? "byo";
    return terminate({
      mode,
      repoSlug: ctx.shared.get("repoSlug") ?? "",
      cloneUrl: ctx.shared.get("cloneUrl") ?? "",
      branch:
        ctx.shared.get("pushBranch") ?? ctx.shared.get("branchName") ?? "",
      sha: ctx.shared.get("pushSha") ?? null,
      pushed: ctx.shared.get("pushed") === true,
      // No hosted pull-request object exists yet — never fabricate one.
      prUrl: null,
      task: ctx.shared.get("task") ?? DEFAULT_TASK,
      codingSummary: ctx.shared.get("codingSummary") ?? null,
      review: ctx.shared.get("review"),
      note:
        (mode === "self-provisioned"
          ? "Ran against a scratch demo repo Sapiom just provisioned for this " +
            "run — set `repoSlug` to your own in-network repo to work on " +
            "something real. "
          : "") +
        "This git host has no hosted pull-request object yet, so the pushed " +
        "branch above is what you review — there is no `prUrl` to open.",
    });
  },
});

/** No repo, a failed coding run, or a red check: nothing branched, nothing pushed. */
const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(
    input: { reason: string; detail?: string; unmet?: string[] },
    ctx: Ctx,
  ) {
    const mode = ctx.shared.get("mode") ?? "byo";
    ctx.logger.info("autonomous PR rejected", { reason: input?.reason });
    return terminate({
      mode,
      repoSlug: ctx.shared.get("repoSlug") ?? "unknown",
      pushed: false,
      reason: input?.reason ?? "unknown",
      detail: input?.detail ?? null,
      checkTail: ctx.shared.get("checkTail") ?? null,
      ...(input?.unmet?.length
        ? { unmet: input.unmet, note: input.detail ?? null }
        : {}),
    });
  },
});

// ────────────────────────────────────────────────────────────── helpers ──

/** Lowercase, hyphenated, bounded — safe inside a repo slug or a branch name. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16) || "run"
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Resolve the sandbox directory the coding run's checkout actually lives in,
 * instead of trusting that `gitRepository` cloned to exactly
 * `/workspace/<slug>`. That path is `models.coding`'s documented convention,
 * not a contract this run necessarily kept, so it's verified — a `test -d
 * .git` at the candidate — before anything is `exec`'d there. If it doesn't
 * hold, falls back to locating the checkout by its `.git` directory anywhere
 * in the sandbox, then re-verifies that candidate too. Returns `{ cwd: null,
 * probe }` (never a guess) when nothing can be confirmed, so the caller can
 * route to a clear, diagnosable rejection instead of running commands in the
 * wrong directory.
 */
async function resolveCheckoutCwd(
  box: ReturnType<Ctx["sapiom"]["sandboxes"]["attach"]>,
  repoSlug: string,
  ctx: Ctx,
): Promise<{ cwd: string | null; probe: string }> {
  const probeLines: string[] = [];

  const hasGit = async (cwd: string): Promise<boolean> => {
    try {
      const res = await box.exec("test -d .git", { cwd, timeout: 15_000 });
      return res.exitCode === 0;
    } catch (err) {
      probeLines.push(`checking \`${cwd}\` threw: ${String(err)}`);
      return false;
    }
  };

  const candidate = `/workspace/${repoSlug}`;
  if (await hasGit(candidate)) {
    return { cwd: candidate, probe: `confirmed at \`${candidate}\`` };
  }
  probeLines.push(`\`${candidate}\` has no checkout (no .git)`);

  // Fall back: locate any `.git` directory in the sandbox and prefer one
  // whose parent directory name matches the repo slug.
  try {
    const find = await box.exec(
      "find / -maxdepth 6 -type d -name .git -not -path '*/node_modules/*' 2>/dev/null",
      { cwd: "/", timeout: 20_000 },
    );
    const gitDirs = find.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    probeLines.push(
      gitDirs.length
        ? `discovery found ${gitDirs.length} checkout(s): ${gitDirs.join(", ")}`
        : "discovery found no checkouts anywhere in the sandbox",
    );

    const checkoutDirs = gitDirs.map((g) => g.replace(/\/\.git$/, ""));
    const bySlug = checkoutDirs.filter((d) => d.split("/").pop() === repoSlug);
    const winner =
      bySlug.length === 1
        ? bySlug[0]
        : checkoutDirs.length === 1
          ? checkoutDirs[0]
          : null;

    if (winner && (await hasGit(winner))) {
      ctx.logger.info("checkout wasn't at the documented path; located it", {
        repoSlug,
        resolved: winner,
      });
      return { cwd: winner, probe: probeLines.join("; ") };
    }
  } catch (err) {
    probeLines.push(`discovery threw: ${String(err)}`);
  }

  return { cwd: null, probe: probeLines.join("; ") };
}

/** Last `max` chars of the combined stdout/stderr — enough to see a failure. */
function tail(stdout: string, stderr: string, max = 2000): string {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  return combined.length > max ? combined.slice(-max) : combined;
}

/** Extract the self-review from model output; fall back to a safe default. */
function parseReview(output: string | null): Review {
  const fallback: Review = {
    verdict: "comment",
    summary: "Self-review unavailable; see the coding agent's own summary.",
    notes: [],
  };
  if (!output) return fallback;
  try {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end < 0) return fallback;
    const raw = JSON.parse(output.slice(start, end + 1)) as Partial<Review>;
    const verdict =
      raw.verdict === "approve" ||
      raw.verdict === "comment" ||
      raw.verdict === "request_changes"
        ? raw.verdict
        : fallback.verdict;
    return {
      verdict,
      summary: typeof raw.summary === "string" ? raw.summary : fallback.summary,
      notes: Array.isArray(raw.notes)
        ? raw.notes.filter((n): n is string => typeof n === "string")
        : [],
    };
  } catch {
    return fallback;
  }
}

export const agent = defineAgent<AutonomousPrInput, Shared>({
  name: "autonomous-pr",
  entry: "plan",
  steps: { plan, implement, verify, push, review, summary, rejected },
});
