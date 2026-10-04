import { describe, expect, it } from "vitest";

import {
  ACTIONS,
  decodeAction,
  draftCard,
  encodeAction,
  issueCard,
  mrkdwnLink,
  nudge,
  slackToPlain,
  workingCard,
} from "./blocks";
import type { Account, Draft, Issue } from "./issues";

const now = new Date("2026-10-01T00:00:00Z");
const account: Account = {
  id: "acc",
  name: "Acme <Corp>",
  slackChannelId: "C1",
  deskId: null,
  createdAt: now,
};
const issue: Issue = {
  id: "iss-1",
  number: 7,
  accountId: "acc",
  deskId: null,
  source: "slack",
  status: "new",
  category: "bug",
  priority: "high",
  title: "Login & SSO fail",
  summary: null,
  customerChannel: "C1",
  customerRootTs: "1.0",
  triageRootTs: null,
  triageChannel: null,
  ownerSlackId: null,
  linearIssueId: null,
  linearIdentifier: null,
  linearUrl: null,
  linearState: null,
  onHoldAt: null,
  cardDirty: false,
  createdAt: now,
  updatedAt: now,
  closedAt: null,
};
const draft: Draft = {
  id: "dr-1",
  issueId: "iss-1",
  cardChannel: null,
  cardTs: null,
  text: "Thanks, looking now.",
  citations: null,
  causationId: null,
  confidence: null,
  summary: null,
  status: "pending",
  decidedBy: null,
  decidedAt: null,
  createdAt: now,
};

type Btn = { action_id: string; value: string };
/** The mrkdwn text of the block with this `block_id` (a section's text, or a context's first element). */
const textOf = (blocks: Record<string, unknown>[], id: string): string => {
  const b = blocks.find((x) => x.block_id === id) as
    | { text?: { text: string }; elements?: { text: string }[] }
    | undefined;
  return b?.text?.text ?? b?.elements?.[0]?.text ?? "";
};
const buttons = (blocks: Record<string, unknown>[]): Btn[] =>
  blocks
    .filter((b) => b.type === "actions")
    .flatMap((b) => b.elements as Btn[]);

describe("action codec", () => {
  it("round-trips every M1 action", () => {
    for (const [owner, verbs] of Object.entries(ACTIONS)) {
      for (const verb of verbs) {
        expect(
          decodeAction(encodeAction(owner as "issue" | "draft", verb)),
        ).toEqual({ owner, verb });
      }
    }
  });

  it("returns null for ids the support desk does not own", () => {
    for (const id of [
      "meeting.slot",
      "draft",
      "draft.",
      ".approve",
      "Draft.approve",
      "draft.approve.x",
      "",
    ]) {
      expect(decodeAction(id)).toBeNull();
    }
  });

  it("rejects a malformed verb", () => {
    expect(() => encodeAction("draft", "Approve!")).toThrow();
  });
});

describe("issueCard", () => {
  it("shows Take and Close on an unowned open issue, value = issue id", () => {
    expect(buttons(issueCard(issue, account))).toMatchObject([
      { action_id: "issue.take", value: "iss-1" },
      { action_id: "issue.close", value: "iss-1" },
    ]);
  });

  it("drops Take once owned and all buttons once closed", () => {
    expect(
      buttons(issueCard({ ...issue, ownerSlackId: "U1" }, account)).map(
        (b) => b.action_id,
      ),
    ).toEqual(["issue.close"]);
    expect(buttons(issueCard({ ...issue, status: "closed" }, account))).toEqual(
      [],
    );
  });

  it("escapes mrkdwn in customer text", () => {
    const text = JSON.stringify(issueCard(issue, account));
    expect(text).toContain("Acme &lt;Corp&gt;");
    expect(text).toContain("Login &amp; SSO fail");
  });

  it("links the title to the customer message, with the title still escaped", () => {
    expect(textOf(issueCard(issue, account), "issue.header")).toBe(
      "*#7 · Acme &lt;Corp&gt;*\n<https://slack.com/archives/C1/p10|Login &amp; SSO fail>",
    );
    const noThread = { ...issue, customerChannel: null, customerRootTs: null };
    expect(textOf(issueCard(noThread, account), "issue.header")).toBe(
      "*#7 · Acme &lt;Corp&gt;*\nLogin &amp; SSO fail",
    );
  });

  it("links the Linear identifier when the URL is stored, and shows it bare otherwise", () => {
    const linked = {
      ...issue,
      linearIdentifier: "SAP-12",
      linearUrl: "https://linear.app/acme/issue/SAP-12/login",
    };
    expect(textOf(issueCard(linked, account), "issue.facts")).toContain(
      "*Linear:* <https://linear.app/acme/issue/SAP-12/login|SAP-12>",
    );
    expect(
      textOf(issueCard({ ...linked, linearUrl: null }, account), "issue.facts"),
    ).toContain("*Linear:* SAP-12");
  });
});

describe("draftCard", () => {
  it("offers Approve, Escalate, Dismiss while pending, value = draft id", () => {
    expect(buttons(draftCard(draft, issue))).toMatchObject([
      { action_id: "draft.approve", value: "dr-1" },
      { action_id: "draft.escalate", value: "dr-1" },
      { action_id: "draft.dismiss", value: "dr-1" },
    ]);
  });

  it("shows who decided instead of buttons afterwards", () => {
    const decided = draftCard(
      { ...draft, status: "approved", decidedBy: "U9" },
      issue,
    );
    expect(buttons(decided)).toEqual([]);
    expect(JSON.stringify(decided)).toContain("Approved and sent by <@U9>");
  });

  it("links the header to the customer thread", () => {
    expect(textOf(draftCard(draft, issue), "draft.header")).toBe(
      "*Draft reply for #7* · <https://slack.com/archives/C1/p10|customer thread>",
    );
    expect(
      textOf(
        draftCard(draft, { ...issue, customerChannel: null }),
        "draft.header",
      ),
    ).toBe("*Draft reply for #7*");
  });
});

describe("nudge", () => {
  it("offers Take when unowned and mentions the owner otherwise", () => {
    expect(buttons(nudge(issue, "no_owner")).map((b) => b.action_id)).toEqual([
      "issue.take",
    ]);
    const owned = nudge(issue, "draft_pending", "U5");
    expect(buttons(owned)).toEqual([]);
    expect(JSON.stringify(owned)).toContain("<@U5>");
  });

  it("links #n to the ticket card when given the triage channel", () => {
    const carded = { ...issue, triageRootTs: "1790889400.000200" };
    expect(
      textOf(
        nudge(carded, "no_draft", null, { triageChannel: "C0T" }),
        "nudge.no_draft",
      ),
    ).toBe(
      "*No draft yet* on <https://slack.com/archives/C0T/p1790889400000200|#7>",
    );
    expect(textOf(nudge(carded, "no_draft"), "nudge.no_draft")).toBe(
      "*No draft yet* on #7",
    );
  });
});

describe("mrkdwnLink", () => {
  it("wraps already-escaped text", () => {
    expect(mrkdwnLink("https://x.test/a", "a &amp; b")).toBe(
      "<https://x.test/a|a &amp; b>",
    );
  });
});

describe("slackToPlain", () => {
  it("makes mentions and broadcasts inert and unwraps links", () => {
    expect(
      slackToPlain(
        "hi <@U1> <@U2|ann> <!here> <!channel> <#C1|general> <https://x.io|docs> <https://y.io>",
      ),
    ).toBe(
      "hi @U1 @ann @here @channel #general docs (https://x.io) https://y.io",
    );
  });

  it("keeps a link label that itself contains '|'", () => {
    expect(slackToPlain("<https://x.io|a | b>")).toBe("a | b (https://x.io)");
  });

  it("drops stray angle brackets, so no tag survives", () => {
    expect(slackToPlain("<script>alert(1)</script> <<<<a")).toBe(
      "scriptalert(1)/script a",
    );
  });

  it("stays linear on a long run of '<'", () => {
    const evil = "<".repeat(200_000);
    const t = performance.now();
    expect(slackToPlain(evil)).toBe("");
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("workingCard", () => {
  const card = [
    {
      type: "section",
      block_id: "draft.header",
      text: { type: "mrkdwn", text: "Draft" },
    },
    { type: "actions", block_id: "draft.actions", elements: [] },
  ];

  it("swaps the clicked actions block for a working line naming the clicker", () => {
    const out = workingCard(card, "draft.actions", "approve", "U1")!;
    expect(out[0]).toEqual(card[0]);
    expect(out[1]).toMatchObject({ type: "context" });
    expect(JSON.stringify(out[1])).toContain("Approving… (<@U1>)");
    expect(card[1].type).toBe("actions");
  });

  it("returns null when the click carries no card or no actions block", () => {
    expect(workingCard(undefined, "draft.actions", "approve", "U1")).toBeNull();
    expect(workingCard([card[0]], "draft.actions", "approve", "U1")).toBeNull();
    expect(workingCard(card, "issue.actions", "close", "U1")).toBeNull();
  });
});
