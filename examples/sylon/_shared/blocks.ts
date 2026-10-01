/**
 * Block Kit builders and the button codec.
 *
 * Every button's `action_id` is `<owner>.<verb>` and its `value` is the id of the row it acts on
 * (issueId or draftId). Each agent owns one prefix and ignores clicks for any other, so adding
 * an agent with new buttons touches no existing agent.
 */
import type { Account, Draft, Issue, IssueStatus } from "./issues";
import type { Block } from "./slack";

export const ACTION_OWNERS = ["issue", "draft"] as const;
export type ActionOwner = (typeof ACTION_OWNERS)[number];

/** The verbs M1 ships. A new verb is a new entry here plus a handler in the owning agent. */
export const ACTIONS = {
  issue: ["take", "close"],
  draft: ["approve", "escalate", "dismiss"],
} as const satisfies Record<ActionOwner, readonly string[]>;

export function encodeAction(owner: ActionOwner, verb: string): string {
  if (!/^[a-z][a-z_]*$/.test(verb))
    throw new Error(`invalid action verb '${verb}'`);
  return `${owner}.${verb}`;
}

/** `null` for any action id Sylon does not own, so a handler can exit early. */
export function decodeAction(
  actionId: string,
): { owner: ActionOwner; verb: string } | null {
  const match = /^([a-z]+)\.([a-z][a-z_]*)$/.exec(actionId);
  if (!match) return null;
  const owner = match[1] as ActionOwner;
  if (!ACTION_OWNERS.includes(owner)) return null;
  return { owner, verb: match[2] };
}

const STATUS_LABEL: Record<IssueStatus, string> = {
  new: "New",
  on_you: "On You",
  on_customer: "On Customer",
  on_hold: "On Hold",
  closed: "Closed",
};

export function statusLabel(status: IssueStatus): string {
  return STATUS_LABEL[status];
}

/**
 * Customer text with Slack's `<…>` tokens made inert, for re-posting elsewhere: user, group and
 * broadcast mentions become plain `@name` (so a customer cannot ping the triage channel), channel
 * links become `#name`, and `<url|label>` becomes `label (url)`. Any stray `<` or `>` is dropped.
 * Escape the result with {@link escapeMrkdwn} before posting it as mrkdwn.
 */
export function slackToPlain(text: string): string {
  // `[^<>]*` cannot cross another `<`, so this is linear on any input.
  const replaced = text.replace(/<([^<>]*)>/g, (_m, inner: string) => {
    const [target, label] = inner.split("|", 2);
    const sigil = target.charAt(0);
    if (sigil === "@" || sigil === "!") {
      const name = label ?? target.slice(1).replace(/^subteam\^/, "");
      return `@${name}`;
    }
    if (sigil === "#") return `#${label ?? target.slice(1)}`;
    return label ? `${label} (${target})` : target;
  });
  return replaced.replace(/[<>]/g, "");
}

/** Slack mrkdwn needs `&`, `<`, `>` escaped in user text. */
export function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function button(
  owner: ActionOwner,
  verb: string,
  text: string,
  value: string,
  style?: "primary" | "danger",
): Block {
  const b: Block = {
    type: "button",
    action_id: encodeAction(owner, verb),
    text: { type: "plain_text", text },
    value,
  };
  if (style) b.style = style;
  return b;
}

const mention = (slackId: string) => `<@${slackId}>`;

/** One-line fallback for notifications and clients that cannot render blocks. */
export function issueCardText(issue: Issue, account: Account): string {
  return `#${issue.number} ${account.name}: ${issue.title ?? "(untitled)"} [${statusLabel(issue.status)}]`;
}

/** The triage card for an issue: number, account, classification, status, owner; Take and Close. */
export function issueCard(issue: Issue, account: Account): Block[] {
  const facts = [
    `*Status:* ${statusLabel(issue.status)}`,
    `*Category:* ${issue.category ?? "unclassified"}`,
    `*Priority:* ${issue.priority ?? "none"}`,
    `*Owner:* ${issue.ownerSlackId ? mention(issue.ownerSlackId) : "unassigned"}`,
  ];
  if (issue.linearIdentifier) facts.push(`*Linear:* ${issue.linearIdentifier}`);
  const blocks: Block[] = [
    {
      type: "section",
      block_id: "issue.header",
      text: {
        type: "mrkdwn",
        text: `*#${issue.number} · ${escapeMrkdwn(account.name)}*\n${escapeMrkdwn(issue.title ?? "(untitled)")}`,
      },
    },
    {
      type: "context",
      block_id: "issue.facts",
      elements: [{ type: "mrkdwn", text: facts.join("   ") }],
    },
  ];
  const buttons: Block[] = [];
  if (!issue.ownerSlackId && issue.status !== "closed")
    buttons.push(button("issue", "take", "Take", issue.id, "primary"));
  if (issue.status !== "closed")
    buttons.push(button("issue", "close", "Close", issue.id));
  if (buttons.length)
    blocks.push({
      type: "actions",
      block_id: "issue.actions",
      elements: buttons,
    });
  return blocks;
}

const DRAFT_OUTCOME: Record<Exclude<Draft["status"], "pending">, string> = {
  approved: "Approved and sent",
  dismissed: "Dismissed",
  escalated: "Escalated",
  superseded: "Superseded by a newer draft",
};

/** The draft reply card in the triage thread: Approve, Escalate, Dismiss while pending; the outcome after. */
export function draftCard(draft: Draft, issue: Issue): Block[] {
  const blocks: Block[] = [
    {
      type: "section",
      block_id: "draft.header",
      text: { type: "mrkdwn", text: `*Draft reply for #${issue.number}*` },
    },
    {
      type: "section",
      block_id: "draft.body",
      text: { type: "mrkdwn", text: escapeMrkdwn(draft.text) },
    },
  ];
  if (draft.status === "pending") {
    blocks.push({
      type: "actions",
      block_id: "draft.actions",
      elements: [
        button("draft", "approve", "Approve", draft.id, "primary"),
        button("draft", "escalate", "Escalate", draft.id),
        button("draft", "dismiss", "Dismiss", draft.id, "danger"),
      ],
    });
  } else {
    const by = draft.decidedBy ? ` by ${mention(draft.decidedBy)}` : "";
    blocks.push({
      type: "context",
      block_id: "draft.outcome",
      elements: [
        { type: "mrkdwn", text: `${DRAFT_OUTCOME[draft.status]}${by}` },
      ],
    });
  }
  return blocks;
}

const NUDGE_TEXT: Record<string, string> = {
  no_draft: "No draft yet",
  draft_pending: "Draft waiting for a decision",
  customer_waiting: "Customer is waiting for a reply",
  no_owner: "No owner yet",
};

/** A controller ping in the triage thread. Mentions the owner if set; offers Take when unowned. */
export function nudge(
  issue: Issue,
  kind: string,
  ownerSlackId?: string | null,
): Block[] {
  const owner = ownerSlackId ?? issue.ownerSlackId;
  const label = NUDGE_TEXT[kind] ?? kind;
  const blocks: Block[] = [
    {
      type: "section",
      block_id: `nudge.${kind}`,
      text: {
        type: "mrkdwn",
        text: `${owner ? `${mention(owner)} ` : ""}*${label}* on #${issue.number}`,
      },
    },
  ];
  if (!owner && issue.status !== "closed") {
    blocks.push({
      type: "actions",
      block_id: "nudge.actions",
      elements: [button("issue", "take", "Take", issue.id, "primary")],
    });
  }
  return blocks;
}
