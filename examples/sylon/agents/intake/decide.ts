/**
 * intake's classification: the Jev questions, and the pure rule that turns their answers into
 * open / link / ignore. Kept free of I/O so the thresholds are unit-tested.
 */
import type { DecisionQuestion } from "@sapiom/tools";

/** `is_issue` at or above this opens an issue. */
export const IS_ISSUE_MIN = 0.6;
/** A `linked_issue` pick other than `new` at or above this links the message to that issue. */
export const LINK_MIN = 0.5;

export const CATEGORIES = {
  bug: "Something in the product is broken or behaves wrongly",
  question: "How to do something, or how something works",
  feature_request: "Asks for a capability the product does not have",
  meeting_request: "Asks for a call or a meeting",
  billing: "Invoices, charges, plans, refunds",
  other: null,
} as const;
export type Category = keyof typeof CATEGORIES;

export const PRIORITIES = {
  urgent: "Production is down or data is at risk; needs action now",
  high: "Blocks the customer's work, no workaround",
  normal: "A real problem or question with a workaround or no deadline",
  low: "Nice to have, cosmetic, or informational",
} as const;
export type Priority = keyof typeof PRIORITIES;

export const NEW_ISSUE = "new";

/** An open issue offered to Jev as a `linked_issue` option. */
export interface Candidate {
  issueId: string;
  number: number;
  title: string;
  lastMessage: string | null;
}

/** Option key for a candidate: Jev answers with keys, code maps them back to ids. */
export const optionKey = (c: Pick<Candidate, "number">) => `issue_${c.number}`;

export function questions(candidates: Candidate[]) {
  const linkCriteria: Record<string, string | null> = {
    [NEW_ISSUE]:
      "None of the open issues: the message is about something else, or is not about an issue",
  };
  for (const c of candidates)
    linkCriteria[optionKey(c)] =
      `#${c.number} ${c.title}${c.lastMessage ? ` (last message: ${c.lastMessage})` : ""}`;
  return {
    is_issue: {
      type: "noul",
      instructions:
        "Does `message` ask the vendor team for help, report a problem, or request something from them?",
      criteria: {
        true: "A question, a problem report, or a request that needs a reply or action",
        false:
          "A thank-you, an acknowledgement, small talk, or an announcement that needs nothing",
      },
    },
    category: {
      type: "choice",
      instructions: "Which category fits `message` best?",
      criteria: { ...CATEGORIES },
    },
    priority: {
      type: "choice",
      instructions: "How urgent is `message` for the customer?",
      criteria: { ...PRIORITIES },
    },
    linked_issue: {
      type: "choice",
      instructions:
        "Is `message` a follow-up on one of the account's open issues (listed as options)? Pick that issue, or `new`.",
      criteria: linkCriteria,
    },
  } satisfies Record<string, DecisionQuestion>;
}

/** The Jev answers intake keeps (stored on `messages.jev`). */
export interface IntakeJev {
  is_issue: { noul: number };
  category: { choice: string; probabilities: Record<string, number> };
  priority: { choice: string; probabilities: Record<string, number> };
  linked_issue: { choice: string; probabilities: Record<string, number> };
}

export type Decision =
  | { kind: "open"; reason: "ticket" | "jev" | "unclassified" }
  | { kind: "link"; issueId: string; reason: "thread" | "jev" }
  | { kind: "ignore" };

/**
 * Order matters: a reply in an issue's customer thread always links; the 🎫 reaction always opens;
 * a confident Jev link beats `is_issue` (a follow-up like "any update?" may not read as an issue);
 * with no Jev answer at all the message opens an issue, because dropping a customer's bug report on
 * a transient classifier error is worse than one issue to close by hand.
 */
export function decide(input: {
  threadIssueId: string | null;
  forced: boolean;
  jev: IntakeJev | null;
  candidates: Candidate[];
}): Decision {
  if (input.threadIssueId)
    return { kind: "link", issueId: input.threadIssueId, reason: "thread" };
  if (input.forced) return { kind: "open", reason: "ticket" };
  const jev = input.jev;
  if (!jev) return { kind: "open", reason: "unclassified" };
  const pick = jev.linked_issue.choice;
  if (
    pick !== NEW_ISSUE &&
    (jev.linked_issue.probabilities[pick] ?? 0) >= LINK_MIN
  ) {
    const target = input.candidates.find((c) => optionKey(c) === pick);
    if (target) return { kind: "link", issueId: target.issueId, reason: "jev" };
  }
  if (jev.is_issue.noul >= IS_ISSUE_MIN) return { kind: "open", reason: "jev" };
  return { kind: "ignore" };
}

export function categoryOf(jev: IntakeJev | null): Category {
  const c = jev?.category.choice;
  return c && c in CATEGORIES ? (c as Category) : "other";
}

export function priorityOf(jev: IntakeJev | null): Priority {
  const p = jev?.priority.choice;
  return p && p in PRIORITIES ? (p as Priority) : "normal";
}
