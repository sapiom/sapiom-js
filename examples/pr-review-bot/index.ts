import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/**
 * PR Review Bot — a coding agent reviews a pull request, then posts feedback.
 *
 * A concrete build on the durable pause/resume spine: `watch` registers a PR
 * webhook and then **suspends at $0** via `pauseUntilSignal` — no polling loop,
 * no held worker — until a pull request is opened. When the webhook fires, the
 * run wakes with the PR payload as its input and:
 *
 *   1. `review`  — hands the diff to a coding agent (`models.coding.run`) that
 *                  checks out the code in a sandbox and analyzes it, with a
 *                  standing instruction to flag any change that ships without
 *                  matching test coverage.
 *   2. `assess`  — an LLM (`models.run`) turns those raw findings into a short,
 *                  structured review: a verdict, a summary, and a list of the
 *                  missing tests.
 *   3. report    — posts the review through the configured channel: your own
 *                  email (`email.send`) or a bring-your-own Slack token read
 *                  from the Vault (`vault.get`) — never baked into code.
 *
 *   watch ──(pause: wait for `pr.opened`, $0 while idle)──▶ review ──▶ assess ─┬─▶ reportEmail ─┬─▶ posted
 *                                                                              └─▶ reportSlack ─┤
 *                                                                                               └─▶ failed
 *
 * Resume contract: `watch` registers `{ executionId, signal, correlationId }`
 * with the webhook source and pauses; the source fires that signal when a PR is
 * opened (in dev, via the MCP `signal_workflow` / `workflow_signal` tool — see
 * README). The resumed `review` step's input IS the PR payload.
 *
 * Offline: with no `WEBHOOK_REGISTER_URL` configured (or `DRY_RUN` set), the
 * `dryRun` guard skips the live registration POST and the report steps skip the
 * real send, so `run_local` traces the full graph — watch → paused →
 * auto-resumed review → assess → report → posted — for free. When the resume
 * payload is empty (as in a local run), `review` falls back to a built-in
 * sample PR so the coding agent always has something to analyze.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** String-only config bag (matches how templates receive their `config`). */
type Config = Record<string, string>;

/** Vault ref that holds this workflow's Slack credential (BYO channel). */
const VAULT_REF = "slack";
/** Vault key for the Slack bot token used by `chat.postMessage`. */
const BOT_TOKEN_KEY = "bot_token";
/** Username for the inbox we send review emails from (created once, reused). */
const SENDER_USERNAME = "pr-review-bot";
/** The named signal the PR webhook fires to resume this run. */
const SIGNAL = "pr.opened";

type Channel = "email" | "slack";

/** The run input: what repo to watch, how to deliver the review, plus config. */
interface PrReviewInput {
  /** Repo the webhook watches and the agent reviews. */
  repo?: RepoRef;
  /** Where to deliver the review. Defaults to `email`. */
  via?: Channel;
  /** email: recipient address. slack: channel (`#reviews` or `C0123`). */
  to?: string;
  /** Optional sample PR used when the resume payload is empty (local runs). */
  samplePr?: PrEvent;
  /** Absent (or `DRY_RUN`) ⇒ offline: skip registration and the real send. */
  config?: Config;
}

interface RepoRef {
  owner: string;
  name: string;
  /** HTTPS clone URL the coding agent uses to check the code out. */
  cloneUrl?: string;
}

/**
 * The pull-request event delivered by the webhook — it becomes `review`'s input
 * verbatim. Intentionally open: a real webhook carries more than we read here.
 */
interface PrEvent {
  repo?: RepoRef;
  /** PR number. */
  number?: number;
  title?: string;
  /** Head branch (the change). */
  branch?: string;
  /** Base branch the PR targets. */
  baseBranch?: string;
  author?: string;
  /** Unified diff text, when the source inlines it. */
  diff?: string;
  /** URL to fetch the diff from, when it isn't inlined. */
  diffUrl?: string;
  [key: string]: unknown;
}

interface Review {
  /** Overall call on the PR. */
  verdict: "approve" | "comment" | "request_changes";
  /** One-paragraph summary of the review. */
  summary: string;
  /** Changes that landed without matching test coverage. */
  missingTests: string[];
  /** Other notable findings, each a short line. */
  comments: string[];
}

interface ReportResult extends Record<string, unknown> {
  posted: boolean;
  /** Why we didn't post, when `posted` is false (dryRun, no-credential, …). */
  skipped: string | null;
  via: Channel;
  verdict: Review["verdict"];
}

/** Pre-pause + cross-step state; everything here survives the suspend. */
interface Shared extends Record<string, unknown> {
  config: Config;
  repo: RepoRef | null;
  via: Channel;
  to: string | null;
  dryRun: boolean;
  samplePr: PrEvent;
  correlationId: string;
  pr: PrEvent;
  rawFindings: string;
  review: Review;
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing shared state: ${name}`);
  return value;
}

/**
 * True when there's no live external dependency to talk to — no register URL, or
 * `DRY_RUN` explicitly set. Lets `run_local` exercise the full control flow
 * offline, mirroring how a real deploy talks to a real webhook source and Slack.
 */
function isDryRun(config: Config): boolean {
  const flag = (config.DRY_RUN ?? "").toLowerCase();
  return flag === "1" || flag === "true" || !config.WEBHOOK_REGISTER_URL;
}

/** A plausible PR used when the resume payload is empty (local/offline runs). */
function defaultSamplePr(repo: RepoRef | null): PrEvent {
  return {
    repo: repo ?? { owner: "acme", name: "api" },
    number: 42,
    title: "Add POST /users/:id/avatar upload endpoint",
    branch: "feat/avatar-upload",
    baseBranch: "main",
    author: "octocat",
    diff: [
      "diff --git a/src/users/avatar.ts b/src/users/avatar.ts",
      "+export async function uploadAvatar(userId: string, file: Buffer) {",
      "+  const key = `avatars/${userId}`;",
      "+  await storage.put(key, file);",
      "+  return storage.url(key);",
      "+}",
    ].join("\n"),
  };
}

/** True when the webhook actually delivered PR content (vs an empty resume). */
function hasPrData(event: PrEvent): boolean {
  return Boolean(
    event &&
    (event.number ||
      (event.title && event.title.trim()) ||
      (event.diff && event.diff.trim())),
  );
}

/**
 * Register the resume contract with the webhook source. It is expected to fire
 * `SIGNAL` (with our `correlationId`) when a PR is opened on the watched repo.
 */
async function registerWebhook(
  config: Config,
  body: { resume: unknown; repo: RepoRef | null },
): Promise<void> {
  const url = (config.WEBHOOK_REGISTER_URL ?? "").replace(/\/$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.WEBHOOK_REGISTER_KEY)
    headers.authorization = `Bearer ${config.WEBHOOK_REGISTER_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `register failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }
}

/** Reuse an existing inbox to send from, else provision one. */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  const inbox = await ctx.sapiom.email.inboxes.create({
    username: SENDER_USERNAME,
    displayName: "PR Review Bot",
  });
  return inbox.inboxId;
}

/**
 * Post to Slack via `chat.postMessage` with a bot token. Slack signals errors in
 * the JSON body (`{ ok: false, error }`), not the HTTP status, so we check `ok`.
 */
async function postToSlack(
  token: string,
  channel: string,
  text: string,
): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: new URLSearchParams({ channel, text, unfurl_links: "false" }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!json.ok) {
    throw new Error(`slack chat.postMessage failed: ${String(json.error)}`);
  }
}

/** Render a review as the plain-text body shared by both channels. */
function renderReview(pr: PrEvent, review: Review): string {
  const lines = [
    `PR #${pr.number ?? "?"}: ${pr.title ?? "(untitled)"}`,
    `Verdict: ${review.verdict}`,
    "",
    review.summary,
  ];
  if (review.missingTests.length) {
    lines.push("", "Missing tests:");
    for (const t of review.missingTests) lines.push(`  - ${t}`);
  }
  if (review.comments.length) {
    lines.push("", "Notes:");
    for (const c of review.comments) lines.push(`  - ${c}`);
  }
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────── steps ──
const watch = defineStep({
  name: "watch",
  next: [],
  // Static graph edge: on `SIGNAL`, resume at `review`. Must match the directive.
  pause: { signal: SIGNAL, resumeStep: "review" },
  async run(input: PrReviewInput, ctx: Ctx) {
    const config = input.config ?? {};
    const repo = input.repo ?? null;
    const via: Channel = input.via === "slack" ? "slack" : "email";
    const to = (input.to ?? "").trim() || null;
    const dryRun = isDryRun(config);

    // Everything set before the pause survives in ctx.shared and is read back
    // after resume; the resumed step's *input* is the PR webhook payload itself.
    ctx.shared.set("config", config);
    ctx.shared.set("repo", repo);
    ctx.shared.set("via", via);
    ctx.shared.set("to", to);
    ctx.shared.set("dryRun", dryRun);
    ctx.shared.set("samplePr", input.samplePr ?? defaultSamplePr(repo));
    ctx.shared.set("correlationId", ctx.executionId);

    // Tell the webhook source how to resume this exact run when a PR opens.
    const resume = {
      executionId: ctx.executionId,
      signal: SIGNAL,
      correlationId: ctx.executionId,
    };

    if (dryRun) {
      ctx.logger.info("dry run: skipping webhook registration", {
        correlationId: ctx.executionId,
      });
    } else {
      await registerWebhook(config, { resume, repo });
      ctx.logger.info("webhook registered; pausing for PR", {
        repo: repo ? `${repo.owner}/${repo.name}` : "(any)",
        correlationId: ctx.executionId,
      });
    }

    // Suspend at $0 until the webhook fires SIGNAL for this correlationId.
    return pauseUntilSignal({
      signal: SIGNAL,
      resumeStep: "review",
      correlationId: ctx.executionId,
    });
  },
});

const review = defineStep({
  name: "review",
  next: ["assess"],
  // `event` IS the PR webhook payload delivered by the resume signal.
  async run(event: PrEvent, ctx: Ctx) {
    // Fall back to the sample PR when the resume payload is empty (local runs).
    const pr = hasPrData(event)
      ? event
      : must(ctx.shared.get("samplePr"), "samplePr");
    ctx.shared.set("pr", pr);

    const repoLabel = pr.repo ? `${pr.repo.owner}/${pr.repo.name}` : "the repo";
    const diffSection = pr.diff
      ? `Unified diff:\n${pr.diff}`
      : pr.diffUrl
        ? `Fetch and review the diff at: ${pr.diffUrl}`
        : "No diff was provided; review the branch against its base.";

    // The coding agent checks the code out in a sandbox and analyzes it. We do
    // NOT ask it to modify or push anything — this is a read-only review. Its
    // standing instruction is to surface changes that ship without tests.
    const task =
      `Review pull request #${pr.number ?? "?"} ("${pr.title ?? "untitled"}") ` +
      `on ${repoLabel}, branch "${pr.branch ?? "?"}" against "${pr.baseBranch ?? "main"}".` +
      (pr.repo?.cloneUrl
        ? ` Clone from ${pr.repo.cloneUrl} to inspect the code.`
        : "") +
      `\n\nDo NOT modify or push any code — this is a read-only review. ` +
      `Focus on correctness and, above all, TEST COVERAGE: for every behavior ` +
      `the change adds or alters, check whether a matching test exists, and ` +
      `explicitly list any that are missing.\n\n${diffSection}`;

    const run = await ctx.sapiom.models.coding.run({
      task,
      keepSandbox: false,
    });

    // A run can finish unsuccessfully (aborted, errored) and still cost — record
    // whatever it produced and let `assess` reason over it rather than failing.
    const findings =
      run.summary?.trim() ||
      (run.error
        ? `Coding agent did not complete: ${run.error.stage} — ${run.error.message}`
        : "Coding agent returned no findings.");
    ctx.shared.set("rawFindings", findings);
    ctx.logger.info("coding review finished", {
      runId: run.runId,
      success: run.result?.success ?? false,
    });

    return goto("assess", {});
  },
});

const assess = defineStep({
  name: "assess",
  next: ["reportEmail", "reportSlack"],
  async run(_input: unknown, ctx: Ctx) {
    const pr = must(ctx.shared.get("pr"), "pr");
    const findings = must(ctx.shared.get("rawFindings"), "rawFindings");
    const via = ctx.shared.get("via") ?? "email";

    const system =
      "You are a senior engineer turning a coding agent's raw review notes into a " +
      "concise, structured PR review. Weigh test coverage heavily: any behavior " +
      "that changed without a matching test belongs in `missingTests`. Pick a " +
      "verdict: `request_changes` if there are missing tests or real defects, " +
      "`comment` for minor notes, `approve` if it is clean. Reply with ONLY " +
      'minified JSON: {"verdict":"approve|comment|request_changes","summary":string,' +
      '"missingTests":string[],"comments":string[]}.';
    const prompt =
      `PR #${pr.number ?? "?"}: ${pr.title ?? "(untitled)"}\n\n` +
      `Coding agent findings:\n${findings}`;

    const res = await ctx.sapiom.models.run({ prompt, system, maxTokens: 600 });
    const rev = parseReview(res.output);
    ctx.shared.set("review", rev);
    ctx.logger.info("review assessed", {
      verdict: rev.verdict,
      missingTests: rev.missingTests.length,
    });

    // Deliver through the configured channel.
    return via === "slack" ? goto("reportSlack", {}) : goto("reportEmail", {});
  },
});

const reportEmail = defineStep({
  name: "reportEmail",
  next: ["posted", "failed"],
  async run(_input: unknown, ctx: Ctx) {
    const dryRun = ctx.shared.get("dryRun") ?? true;
    const to = ctx.shared.get("to") ?? null;
    const pr = must(ctx.shared.get("pr"), "pr");
    const review = must(ctx.shared.get("review"), "review");

    // dryRun (run_local / offline): skip the network, report what it would do.
    if (dryRun) {
      ctx.logger.info("dryRun — skipping review email", { to });
      return goto("posted", skip("dryRun", "email", review));
    }
    // No-recipient guard: an unconfigured recipient is an expected onboarding
    // state, not a failure — degrade to a skip so the graph still completes.
    if (!to) {
      ctx.logger.warn("no email recipient configured — skipping send");
      return goto("posted", skip("no-recipient", "email", review));
    }

    try {
      const inboxId = await resolveSenderInbox(ctx);
      const sent = await ctx.sapiom.email.messages.send(inboxId, {
        to,
        subject: `PR review #${pr.number ?? "?"}: ${review.verdict}`,
        text: renderReview(pr, review),
      });
      ctx.logger.info("review emailed", { to, messageId: sent.messageId });
      return goto("posted", {
        posted: true,
        skipped: null,
        via: "email",
        verdict: review.verdict,
      } satisfies ReportResult);
    } catch (err) {
      ctx.logger.error("email send failed", { err: String(err) });
      return goto("failed", { error: String(err) });
    }
  },
});

const reportSlack = defineStep({
  name: "reportSlack",
  next: ["posted", "failed"],
  async run(_input: unknown, ctx: Ctx) {
    const dryRun = ctx.shared.get("dryRun") ?? true;
    const channel = ctx.shared.get("to") ?? null;
    const pr = must(ctx.shared.get("pr"), "pr");
    const review = must(ctx.shared.get("review"), "review");

    if (dryRun) {
      ctx.logger.info("dryRun — skipping Slack post", { channel });
      return goto("posted", skip("dryRun", "slack", review));
    }
    if (!channel) {
      ctx.logger.warn("no Slack channel configured — skipping post");
      return goto("posted", skip("no-recipient", "slack", review));
    }

    // Read the BYO token at runtime — never baked into code.
    let token: string | null = null;
    try {
      token = await ctx.sapiom.vault.get(VAULT_REF, BOT_TOKEN_KEY);
    } catch (err) {
      ctx.logger.warn("vault: no slack token", { err: String(err) });
    }
    // No-key guard: behave like dryRun so a fresh fork traces end to end before
    // you have stored a token.
    if (!token) {
      ctx.logger.warn("no slack token in vault — skipping post", {
        ref: VAULT_REF,
        key: BOT_TOKEN_KEY,
      });
      return goto("posted", skip("no-credential", "slack", review));
    }

    try {
      await postToSlack(token, channel, renderReview(pr, review));
      ctx.logger.info("review posted to slack", { channel });
      return goto("posted", {
        posted: true,
        skipped: null,
        via: "slack",
        verdict: review.verdict,
      } satisfies ReportResult);
    } catch (err) {
      ctx.logger.error("slack post failed", { err: String(err) });
      return goto("failed", { error: String(err) });
    }
  },
});

const posted = defineStep({
  name: "posted",
  next: [],
  terminal: true,
  async run(input: ReportResult) {
    return terminate(input);
  },
});

const failed = defineStep({
  name: "failed",
  next: [],
  terminal: true,
  async run(input: { error: string }) {
    return terminate({
      posted: false,
      failed: true,
      error: input?.error ?? "unknown error",
    });
  },
});

// ─────────────────────────────────────────────────────────────── parsing ──
/** Build a "skipped" report result (no send happened, but the run succeeded). */
function skip(reason: string, via: Channel, review: Review): ReportResult {
  return { posted: false, skipped: reason, via, verdict: review.verdict };
}

/** Extract the structured review from model output; fall back to a safe default. */
function parseReview(output: string | null): Review {
  const fallback: Review = {
    verdict: "comment",
    summary: "Model summary unavailable; see the coding agent's raw findings.",
    missingTests: [],
    comments: [],
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
    const asStrings = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [];
    return {
      verdict,
      summary: typeof raw.summary === "string" ? raw.summary : fallback.summary,
      missingTests: asStrings(raw.missingTests),
      comments: asStrings(raw.comments),
    };
  } catch {
    return fallback;
  }
}

export const agent = defineAgent<PrReviewInput, Shared>({
  name: "pr-review-bot",
  entry: "watch",
  steps: { watch, review, assess, reportEmail, reportSlack, posted, failed },
});
