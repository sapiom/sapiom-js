/**
 * The watchdog's pure half: whether a failure is this fleet's, what to tell the team to do about
 * it, and the Slack message. No I/O, so every rule here is unit-tested without a network or a
 * database.
 */
import { escapeMrkdwn, mrkdwnLink } from "../../_shared/blocks";
import type { RunFailed } from "../../_shared/events";
import { agentSlug } from "../../_shared/fleet-id";
import type { Block } from "../../_shared/slack";

export const APP_URL = "https://app.sapiom.ai";
export const runUrl = (definitionId: string, executionId: string) =>
  `${APP_URL}/agents/${definitionId}/runs/${executionId}`;

/**
 * Slugs the watchdog reports: the fleet minus itself and the smoke agents. `sapiom.run.failed`
 * fires for every agent in the org, so anything else is another fleet's (or nobody's) business.
 * The engine never sends the watchdog its own failure.
 */
export const WATCHED_SLUGS: readonly string[] = [
  "intake",
  "copilot",
  "escalation",
  "controller",
  "urgent-pager",
  "digest",
].map((key) => agentSlug(key));

export const isWatched = (slug: string) => WATCHED_SLUGS.includes(slug);

/**
 * One failure's dedup key. A resumed run that fails again is a new failure with the same
 * execution id, so the finish time is part of the key, as it is of the event's own id.
 */
export const failureKey = (e: Pick<RunFailed, "executionId" | "finishedAt">) =>
  `${e.executionId}:${e.finishedAt ?? ""}`;

export interface Failure {
  executionId: string;
  slug: string;
  definitionId: string;
  step: string;
  /** 0-based, as the API counts. */
  attempt: number | null;
  faultClass: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  issueNumber: number | null;
}

export function describeFailure(
  e: RunFailed,
  issueNumber: number | null,
): Failure {
  return {
    executionId: e.executionId,
    slug: e.slug,
    definitionId: e.definitionId,
    step: e.failedStep ?? "unknown",
    attempt: e.attempt ?? null,
    faultClass: e.faultClass ?? null,
    startedAt: e.startedAt ?? null,
    finishedAt: e.finishedAt ?? null,
    issueNumber,
  };
}

const REPLAY = "Replay the run from its page once the cause is fixed.";

/**
 * Short imperative steps for one failure. The event carries no error text, so the advice goes by
 * fault class and agent, and each step names the error that it applies to; the run page shows the
 * error itself.
 */
export function actionItems(
  agent: string,
  step: string,
  faultClass: string | null,
): string[] {
  if (faultClass === "infra")
    return [
      "Sapiom could not run the step (dispatch or sandbox); the step's code did not fail.",
      "Replay the run. If it fails the same way again, send Sapiom the run id.",
    ];
  const items = [`Open the run and read the ${step} step's error.`];
  if (/copilot$/.test(agent))
    items.push(
      "If no draft reached the triage thread, reply to the customer by hand.",
    );
  if (/(escalation|controller)$/.test(agent))
    items.push(
      "If the error is a Linear 401, 403 or scope error, reconnect Linear in Connectors.",
    );
  items.push(
    "If it is not_in_channel or channel_not_found, invite the Slack bot to the channel; if it is missing_scope or invalid_auth, reconnect Slack in Connectors.",
    "If a table, column or config key is missing, rerun setup to apply migrations and seed config.",
    "If it is a 429 or a 5xx, treat it as transient.",
    REPLAY,
  );
  return items;
}

const clock = (iso: string | null) =>
  iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "unknown";

const FAULT: Record<string, string> = {
  infra: "infra (Sapiom's side)",
  workload: "workload (the step's code)",
};

/** The one message per failure: Block Kit with a plain-text fallback. */
export function failureMessage(f: Failure): { text: string; blocks: Block[] } {
  // Attempts are 0-based on the API; people count from 1.
  const attempt = f.attempt != null ? ` (attempt ${f.attempt + 1})` : "";
  const step = escapeMrkdwn(f.step);
  const head = `:rotating_light: ${f.slug} failed at ${step}${attempt}`;
  const fault = f.faultClass
    ? `\nFault: ${escapeMrkdwn(FAULT[f.faultClass] ?? f.faultClass)}`
    : "";
  const issue = f.issueNumber != null ? `\nIssue: #${f.issueNumber}` : "";
  const items = actionItems(f.slug, f.step, f.faultClass)
    .map((i) => `• ${escapeMrkdwn(i)}`)
    .join("\n");
  return {
    text: head,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${head.replace(f.slug, `*${f.slug}*`)}${fault}${issue}`,
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
