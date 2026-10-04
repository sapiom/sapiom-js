/**
 * The drawer's ticket actions. A Console button emits the `slack.block_actions` event a click on
 * the Slack card would produce, through the tenant events API. intake handles Take and Close, the
 * copilot handles Approve, Escalate and Dismiss, each on its existing path: one implementation of
 * every verb, and the Slack card redraws as it does after a click in Slack.
 *
 * The click names the card the Slack button sits on: the issue card (`triage_root_ts` in the desk's
 * triage channel) for Take and Close, the draft card for the draft verbs. intake accepts an issue
 * action only from the issue's own triage channel, so that is the channel the click carries.
 *
 * The App Link has no per-user identity, so the clicker is always `console`: it is the owner a
 * Take records and the name on "Closed by" and on a decided draft.
 */
import { randomUUID } from "node:crypto";

import {
  ACTIONS,
  CONSOLE_ACTOR,
  encodeAction,
  type ActionOwner,
} from "../../_shared/blocks";
import { SlackBlockActions } from "../../_shared/events";

export { CONSOLE_ACTOR };

export const ACTION_TYPE = "slack.block_actions";

export type ActionVerb =
  | (typeof ACTIONS.issue)[number]
  | (typeof ACTIONS.draft)[number];

export interface ActionTarget {
  issue: {
    id: string;
    status: string;
    ownerSlackId: string | null;
    triageRootTs: string | null;
  };
  triageChannel: string;
  /** The issue's pending draft, if it has one. */
  draft: {
    id: string;
    cardChannel: string | null;
    cardTs: string | null;
  } | null;
}

export type ActionPlan =
  | {
      ok: true;
      type: typeof ACTION_TYPE;
      /** The emit id: the engine dedups on it, so a retried POST starts nothing twice. */
      id: string;
      payload: SlackBlockActions;
    }
  | { ok: false; status: number; reason: string };

const ownerOf = (verb: string): ActionOwner | null =>
  (ACTIONS.issue as readonly string[]).includes(verb)
    ? "issue"
    : (ACTIONS.draft as readonly string[]).includes(verb)
      ? "draft"
      : null;

/**
 * The click to emit for `verb` on the target, or why the Slack card would not offer that button:
 * Take only on an open, unowned issue; Close only on an open one; the draft verbs only while a
 * draft is pending and its card is posted.
 */
export function planAction(
  verb: string,
  target: ActionTarget,
  nonce: string = randomUUID(),
): ActionPlan {
  const owner = ownerOf(verb);
  if (!owner)
    return { ok: false, status: 400, reason: `unknown action '${verb}'` };
  const { issue } = target;
  if (issue.status === "closed")
    return { ok: false, status: 409, reason: "the ticket is closed" };

  let value: string;
  let channel: string;
  let ts: string;
  if (owner === "issue") {
    if (verb === "take" && issue.ownerSlackId)
      return {
        ok: false,
        status: 409,
        reason: "the ticket already has an owner",
      };
    if (!issue.triageRootTs)
      return {
        ok: false,
        status: 409,
        reason: "the ticket has no triage card",
      };
    value = issue.id;
    channel = target.triageChannel;
    ts = issue.triageRootTs;
  } else {
    const draft = target.draft;
    if (!draft)
      return {
        ok: false,
        status: 409,
        reason: "no draft is waiting for a decision",
      };
    if (!draft.cardTs)
      return { ok: false, status: 409, reason: "the draft has no card yet" };
    value = draft.id;
    channel = draft.cardChannel ?? target.triageChannel;
    ts = draft.cardTs;
  }

  const triggerId = `console:${nonce}`;
  const payload = SlackBlockActions.parse({
    type: "block_actions",
    trigger_id: triggerId,
    user: { id: CONSOLE_ACTOR, name: CONSOLE_ACTOR },
    container: { type: "message", channel_id: channel, message_ts: ts },
    channel: { id: channel },
    actions: [
      {
        action_id: encodeAction(owner, verb),
        block_id: `${owner}.actions`,
        value,
        type: "button",
      },
    ],
  });
  return {
    ok: true,
    type: ACTION_TYPE,
    id: `${ACTION_TYPE}:${triggerId}`,
    payload,
  };
}
