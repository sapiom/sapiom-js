import { describe, expect, it } from "vitest";

import {
  ACTIONS,
  decodeAction,
  draftCard,
  encodeAction,
  issueCard,
  nudge,
} from "./blocks";
import type { Account, Draft, Issue } from "./issues";

const now = new Date("2026-10-01T00:00:00Z");
const account: Account = {
  id: "acc",
  name: "Acme <Corp>",
  slackChannelId: "C1",
  createdAt: now,
};
const issue: Issue = {
  id: "iss-1",
  number: 7,
  accountId: "acc",
  source: "slack",
  status: "new",
  category: "bug",
  priority: "high",
  title: "Login & SSO fail",
  summary: null,
  customerChannel: "C1",
  customerRootTs: "1.0",
  triageRootTs: null,
  ownerSlackId: null,
  linearIssueId: null,
  linearIdentifier: null,
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
  status: "pending",
  decidedBy: null,
  decidedAt: null,
  createdAt: now,
};

type Btn = { action_id: string; value: string };
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

  it("returns null for ids Sylon does not own", () => {
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
});
