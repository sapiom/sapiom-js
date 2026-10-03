/**
 * The watchdog's pure half: which failures are new, what to tell the team to do about each, and
 * the Slack message. No I/O, so every rule here is unit-tested without a network or a database.
 */
import { escapeMrkdwn, mrkdwnLink, slackToPlain } from "../../_shared/blocks";
import { agentSlug } from "../../_shared/fleet-id";
import type { Block } from "../../_shared/slack";

/** First run: how far back to look when there is no cursor. */
export const FIRST_LOOKBACK_MS = 60 * 60 * 1000;
/**
 * Later runs start this far before the cursor. The list filters on start time and has no
 * finish-time filter, so a run that started before the cursor and failed after it is only seen if
 * the window reaches back past its start. This must exceed the longest plausible run; the
 * reported set makes the overlap harmless.
 */
export const OVERLAP_MS = 6 * 60 * 60 * 1000;
/** A "cannot poll" alert for the same problem repeats no more often than this. */
export const PROBLEM_REPEAT_MS = 60 * 60 * 1000;
/** Failures posted in one tick; the rest become a single "and N more" line. */
export const MAX_POSTS = 10;
export const ERROR_MAX = 300;

export const APP_URL = "https://app.sapiom.ai";
export const EVENTS_URL = `${APP_URL}/agents/events`;
export const runUrl = (definitionId: string, executionId: string) =>
  `${APP_URL}/agents/${definitionId}/runs/${executionId}`;

/** Slugs the watchdog polls: the fleet minus itself and the smoke agents. */
export const WATCHED_SLUGS: readonly string[] = [
  "intake",
  "copilot",
  "escalation",
  "controller",
  "urgent-pager",
].map((key) => agentSlug(key));

/** A row of `GET /v1/workflows/executions`. */
export interface Execution {
  id: string;
  name?: string;
  definitionId: string;
  status: string;
  currentStep?: string | null;
  currentStepAttempt?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface StepRecord {
  /** The REST detail names it `stepName`; `name` is kept for older shapes. */
  stepName?: string;
  name?: string;
  attempt?: number | null;
  status: string;
  error?: unknown;
  faultClass?: string | null;
}

/** `GET /v1/workflows/executions/:id`: the row plus the error and per-step records. */
export interface ExecutionDetail extends Execution {
  error?: unknown;
  traceId?: string | null;
  steps?: StepRecord[];
}

export interface Failure {
  executionId: string;
  slug: string;
  definitionId: string;
  step: string;
  attempt: number | null;
  error: string;
  faultClass: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  issueNumber: number | null;
}

/** Where a poll starts. */
export function lookbackFrom(cursor: Date | null, now: Date): Date {
  return new Date(
    cursor ? cursor.getTime() - OVERLAP_MS : now.getTime() - FIRST_LOOKBACK_MS,
  );
}

/**
 * The failures to report, oldest first: not reported before, not the watchdog's own run, and
 * listed once even if two definitions' polls both returned it.
 */
export function newFailures(
  rows: Execution[],
  reported: ReadonlySet<string>,
  selfExecutionId: string,
): Execution[] {
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      if (r.id === selfExecutionId || reported.has(r.id) || seen.has(r.id))
        return false;
      seen.add(r.id);
      return true;
    })
    .sort((a, b) => when(a).localeCompare(when(b)));
}

const when = (e: Execution) => e.finishedAt ?? e.startedAt ?? "";

/** Post the first {@link MAX_POSTS}; the rest are only counted. */
export function splitBatch<T>(items: T[]): { post: T[]; more: T[] } {
  return { post: items.slice(0, MAX_POSTS), more: items.slice(MAX_POSTS) };
}

const text = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const m = (v as { message?: unknown }).message;
    if (typeof m === "string") return m;
    return JSON.stringify(v);
  }
  return "";
};

/** The failed step (the last one that failed, else the row's current step) and the error text. */
export function describeFailure(
  slug: string,
  row: Execution,
  detail: ExecutionDetail | null,
  issueNumber: number | null,
): Failure {
  const failed = [...(detail?.steps ?? [])]
    .reverse()
    .find((s) => s.status.toLowerCase() === "failed");
  return {
    executionId: row.id,
    slug,
    definitionId: row.definitionId,
    step:
      failed?.stepName ??
      failed?.name ??
      detail?.currentStep ??
      row.currentStep ??
      "unknown",
    attempt:
      failed?.attempt ??
      detail?.currentStepAttempt ??
      row.currentStepAttempt ??
      null,
    // The step's own error names the cause (a 400 from a provider, a Slack error code); the run's
    // error is usually only "exceeded retry cap", so it is the fallback.
    error: text(failed?.error) || text(detail?.error) || "no error recorded",
    faultClass: failed?.faultClass ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    issueNumber,
  };
}

const SLACK_ERRORS =
  /not_in_channel|channel_not_found|missing_scope|invalid_auth|token_revoked|account_inactive|is_archived/i;
const AUTH_OR_SCOPE =
  /\b40[13]\b|unauthori[sz]ed|forbidden|invalid[_ ]grant|insufficient|scope|expired|token|authenticat|not connected/i;
const TRANSIENT =
  /\b(429|5\d\d)\b|rate.?limit|too many requests|overloaded|timed? ?out|timeout|bad gateway|unavailable|ECONNRESET/i;
const DATABASE =
  /database|postgres|ECONNREFUSED|connection terminated|relation ".*" does not exist|column ".*" does not exist|deadlock|\bsql\b/i;

const REPLAY = "Replay the run from the Events page once it is fixed.";

/**
 * Short imperative steps for one failure, most specific first. Several can apply (a Slack error
 * inside the copilot); the generic fallback appears only when nothing else matched.
 */
export function actionItems(
  agent: string,
  step: string,
  error: string,
  faultClass?: string | null,
): string[] {
  const items: string[] = [];
  const e = error;
  if (SLACK_ERRORS.test(e)) {
    items.push(
      "If the error is not_in_channel or channel_not_found, invite the Slack bot to the channel and check the channel id in config.",
      "If it is missing_scope or invalid_auth, reconnect Slack in Connectors and grant the scopes it names.",
    );
  }
  if (
    (/linear|mcp/i.test(e) || /escalation/.test(agent)) &&
    AUTH_OR_SCOPE.test(e) &&
    !SLACK_ERRORS.test(e)
  ) {
    items.push("Reconnect Linear in Connectors and check its write scope.");
  }
  if (/no structured draft/i.test(e)) {
    items.push(
      "Reply to the customer by hand; the draft was not produced.",
      "Check the copilot step logs for the model output.",
    );
  }
  if (/model_not_available|llm\.services\.sapiom\.ai.*→ (400|404)\b/i.test(e)) {
    items.push(
      "The LLM gateway rejected the model: pass a routing label it serves (sonnet, opus, haiku) as `model`, not a model id, then redeploy the agent.",
    );
  }
  if (/MissingConfigError|config key '.*' is not set/i.test(e)) {
    items.push(
      "Run `pnpm run setup` in examples/support-desk to seed the missing config key.",
    );
  }
  if (DATABASE.test(e) && !/MissingConfigError/.test(e)) {
    items.push(
      "Check the fleet Postgres resource is up.",
      "Run `pnpm run setup` to apply pending migrations if a table or column is missing.",
    );
  }
  if (
    TRANSIENT.test(e) ||
    /transient|retryable|timeout/i.test(faultClass ?? "")
  ) {
    items.push(
      "Treat as transient (rate limit or upstream 5xx): check the Jev decisions or LLM status.",
    );
  }
  if (items.length === 0) {
    items.push(
      `Open the run and read the ${step} step log.`,
      "Fix the cause named in the error.",
    );
  }
  items.push(REPLAY);
  return items;
}

export const truncate = (s: string, max = ERROR_MAX) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

const clock = (iso: string | null) =>
  iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "unknown";

/** The one message per failed execution: Block Kit with a plain-text fallback. */
export function failureMessage(f: Failure): { text: string; blocks: Block[] } {
  const error = escapeMrkdwn(truncate(slackToPlain(f.error)));
  // Attempts are 0-based on the API; people count from 1.
  const attempt = f.attempt != null ? ` (attempt ${f.attempt + 1})` : "";
  const issue = f.issueNumber != null ? `\nIssue: #${f.issueNumber}` : "";
  const items = actionItems(f.slug, f.step, f.error, f.faultClass)
    .map((i) => `• ${escapeMrkdwn(i)}`)
    .join("\n");
  const head = `:rotating_light: ${f.slug} failed at ${f.step}${attempt}`;
  return {
    // The fallback is read as mrkdwn too, so the run's error cannot carry a live mention.
    text: escapeMrkdwn(
      `${slackToPlain(head)}: ${truncate(slackToPlain(f.error), 120)}`,
    ),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${head.replace(f.slug, `*${f.slug}*`)}${issue}\n\`\`\`${error.replace(/```/g, "'''")}\`\`\``,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Started ${clock(f.startedAt)} · finished ${clock(f.finishedAt)} · ${mrkdwnLink(runUrl(f.definitionId, f.executionId), "Open the run")} · run \`${f.executionId}\``,
          },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Action items*\n${items}` },
      },
    ],
  };
}

export function moreMessage(n: number): string {
  return `and ${n} more failed ${n === 1 ? "run" : "runs"}: ${mrkdwnLink(EVENTS_URL, "see the Events page")}`;
}

/** The line posted when the watchdog itself cannot read the API, so its own outage is not silent. */
export function cannotPollMessage(problem: string): string {
  return `:warning: Support desk watchdog cannot poll: ${escapeMrkdwn(truncate(slackToPlain(problem)))}. Run \`pnpm run setup --only watchdog\` to re-provision its key.`;
}
