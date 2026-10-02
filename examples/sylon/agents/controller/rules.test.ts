import { describe, expect, it } from "vitest";

import {
  dueNudges,
  nudgeKey,
  skipKey,
  type DraftRow,
  type IssueRow,
  type MessageRow,
  type RuleInput,
} from "./rules";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const MINUTES = 5;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const AT_THRESHOLD = MINUTES * 60_000;
const JUST_UNDER = AT_THRESHOLD - 1;

const issue = (over: Partial<IssueRow> = {}): IssueRow => ({
  id: "issue-1",
  status: "new",
  ownerSlackId: null,
  triageRootTs: "1790000000.000100",
  createdAt: ago(AT_THRESHOLD),
  ...over,
});
const draft = (over: Partial<DraftRow> = {}): DraftRow => ({
  id: "draft-1",
  issueId: "issue-1",
  status: "pending",
  createdAt: ago(AT_THRESHOLD),
  ...over,
});
const message = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: "msg-1",
  issueId: "issue-1",
  direction: "customer",
  text: "it is still broken",
  ts: null,
  createdAt: ago(AT_THRESHOLD),
  ...over,
});

const run = (over: Partial<RuleInput>) =>
  dueNudges({
    issues: [],
    drafts: [],
    messages: [],
    sent: [],
    now: NOW,
    minutes: MINUTES,
    ...over,
  });
const keys = (over: Partial<RuleInput>) => run(over).map((n) => n.key);

describe("no_owner", () => {
  it("fires at exactly the threshold, not a millisecond before", () => {
    const owned = { drafts: [draft({ status: "approved" })] };
    expect(keys({ ...owned, issues: [issue()] })).toEqual(["no_owner:issue-1"]);
    expect(
      keys({ ...owned, issues: [issue({ createdAt: ago(JUST_UNDER) })] }),
    ).toEqual([]);
  });

  it("does not fire once someone owns the issue", () => {
    expect(
      keys({
        issues: [issue({ ownerSlackId: "U1" })],
        drafts: [draft({ status: "approved" })],
      }),
    ).toEqual([]);
  });

  it("still fires while on hold", () => {
    expect(
      keys({
        issues: [issue({ status: "on_hold" })],
        drafts: [draft({ status: "escalated" })],
      }),
    ).toEqual(["no_owner:issue-1"]);
  });
});

describe("no_draft", () => {
  const owned = issue({ ownerSlackId: "U1" });

  it("fires when an old issue has no draft at all", () => {
    expect(keys({ issues: [owned] })).toEqual(["no_draft:issue-1"]);
    expect(
      keys({ issues: [{ ...owned, createdAt: ago(JUST_UNDER) }] }),
    ).toEqual([]);
  });

  it("does not fire once any draft exists, whatever its status", () => {
    for (const status of ["dismissed", "superseded", "approved"] as const) {
      expect(keys({ issues: [owned], drafts: [draft({ status })] })).toEqual(
        [],
      );
    }
  });
});

describe("draft_pending", () => {
  const owned = issue({ ownerSlackId: "U1" });

  it("fires on the newest pending draft once it has waited the threshold", () => {
    expect(keys({ issues: [owned], drafts: [draft()] })).toEqual([
      "draft_pending:draft-1",
    ]);
    expect(
      keys({
        issues: [owned],
        drafts: [draft({ createdAt: ago(JUST_UNDER) })],
      }),
    ).toEqual([]);
  });

  it("keys on the draft, so a new pending draft re-arms the rule", () => {
    const drafts = [
      draft({
        id: "draft-1",
        status: "superseded",
        createdAt: ago(60 * 60_000),
      }),
      draft({ id: "draft-2" }),
    ];
    const sent = [{ issueId: "issue-1", kind: "draft_pending:draft-1" }];
    expect(keys({ issues: [owned], drafts, sent })).toEqual([
      "draft_pending:draft-2",
    ]);
  });

  it("is silent while on hold", () => {
    expect(
      keys({ issues: [{ ...owned, status: "on_hold" }], drafts: [draft()] }),
    ).toEqual([]);
  });
});

describe("customer_waiting", () => {
  const owned = issue({ ownerSlackId: "U1" });
  const drafted = [draft({ status: "approved" })];

  it("fires when the last customer-thread message is the customer's and has waited the threshold", () => {
    expect(
      keys({ issues: [owned], drafts: drafted, messages: [message()] }),
    ).toEqual(["customer_waiting:msg-1"]);
    expect(
      keys({
        issues: [owned],
        drafts: drafted,
        messages: [message({ createdAt: ago(JUST_UNDER) })],
      }),
    ).toEqual([]);
  });

  it("does not fire once the team replied in the customer thread", () => {
    const messages = [
      message({ createdAt: ago(20 * 60_000) }),
      message({ id: "msg-2", direction: "agent", createdAt: ago(10 * 60_000) }),
    ];
    expect(keys({ issues: [owned], drafts: drafted, messages })).toEqual([]);
  });

  it("ignores internal triage messages when finding the last one", () => {
    const messages = [
      message({ createdAt: ago(20 * 60_000) }),
      message({
        id: "msg-2",
        direction: "internal",
        createdAt: ago(10 * 60_000),
      }),
    ];
    expect(keys({ issues: [owned], drafts: drafted, messages })).toEqual([
      "customer_waiting:msg-1",
    ]);
  });

  it("re-arms on a new customer message", () => {
    const messages = [
      message({ createdAt: ago(30 * 60_000) }),
      message({ id: "msg-2", direction: "agent", createdAt: ago(20 * 60_000) }),
      message({ id: "msg-3", createdAt: ago(10 * 60_000) }),
    ];
    const sent = [{ issueId: "issue-1", kind: "customer_waiting:msg-1" }];
    expect(keys({ issues: [owned], drafts: drafted, messages, sent })).toEqual([
      "customer_waiting:msg-3",
    ]);
  });

  it("stays silent on a message Jev already judged as needing no reply", () => {
    const sent = [
      { issueId: "issue-1", kind: skipKey("customer_waiting", "msg-1") },
    ];
    expect(
      keys({ issues: [owned], drafts: drafted, messages: [message()], sent }),
    ).toEqual([]);
  });

  it("is silent while on hold", () => {
    expect(
      keys({
        issues: [{ ...owned, status: "on_hold" }],
        drafts: drafted,
        messages: [message()],
      }),
    ).toEqual([]);
  });

  it("with the Jev check off, a skip verdict no longer silences it; a sent nudge still does", () => {
    const skipped = [
      { issueId: "issue-1", kind: skipKey("customer_waiting", "msg-1") },
    ];
    const base = { issues: [owned], drafts: drafted, messages: [message()] };
    expect(keys({ ...base, sent: skipped, jevCheck: false })).toEqual([
      "customer_waiting:msg-1",
    ]);
    expect(
      keys({
        ...base,
        sent: [{ issueId: "issue-1", kind: "customer_waiting:msg-1" }],
        jevCheck: false,
      }),
    ).toEqual([]);
  });

  it("orders the thread by Slack ts, so a customer message stored late does not jump ahead of the reply", () => {
    const messages = [
      // Posted first, stored last (a delayed or replayed event).
      message({ ts: "1790000000.000100", createdAt: ago(6 * 60_000) }),
      message({
        id: "msg-2",
        direction: "agent",
        ts: "1790000060.000100",
        createdAt: ago(10 * 60_000),
      }),
    ];
    expect(keys({ issues: [owned], drafts: drafted, messages })).toEqual([]);
  });

  it("falls back to the insert time for a message without a ts", () => {
    const messages = [
      message({ ts: "1790000000.000100", createdAt: ago(20 * 60_000) }),
      message({
        id: "msg-2",
        direction: "agent",
        ts: null,
        createdAt: new Date(1_790_000_060_000),
      }),
    ];
    expect(keys({ issues: [owned], drafts: drafted, messages })).toEqual([]);
  });
});

describe("dedup and scope", () => {
  it("emits every due rule once per issue, and none after they are recorded", () => {
    const issues = [issue()];
    const drafts: DraftRow[] = [];
    const messages = [message()];
    const first = run({ issues, drafts, messages });
    expect(first.map((n) => n.kind)).toEqual([
      "no_owner",
      "no_draft",
      "customer_waiting",
    ]);
    const sent = first.map((n) => ({ issueId: n.issueId, kind: n.key }));
    expect(run({ issues, drafts, messages, sent })).toEqual([]);
  });

  it("dedups per issue: another issue's record does not silence this one", () => {
    const sent = [
      { issueId: "issue-2", kind: nudgeKey("no_owner", "issue-1") },
    ];
    expect(
      keys({
        issues: [issue()],
        drafts: [draft({ status: "approved" })],
        sent,
      }),
    ).toEqual(["no_owner:issue-1"]);
  });

  it("skips closed issues and issues without a triage card", () => {
    expect(
      keys({
        issues: [
          issue({ id: "closed", status: "closed" }),
          issue({ id: "no-card", triageRootTs: null }),
        ],
      }),
    ).toEqual([]);
  });

  it("treats on_you and on_customer like new", () => {
    for (const status of ["on_you", "on_customer"] as const) {
      expect(keys({ issues: [issue({ status })] })).toEqual([
        "no_owner:issue-1",
        "no_draft:issue-1",
      ]);
    }
  });
});
