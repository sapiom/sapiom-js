import { describe, expect, it } from "vitest";

import {
  dueEscalations,
  dueNudges,
  escalationKey,
  escalationTimes,
  nudgeRounds,
  type EscalationInput,
  nudgeKey,
  skipKey,
  type DraftRow,
  type IssueRow,
  type MessageRow,
  type RuleInput,
} from "./rules";
import { EXAMPLE_SLA } from "../../_shared/test-ctx";

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
    repeatMinutes: [60, 240],
    ...over,
  });
const keys = (over: Partial<RuleInput>) => run(over).map((n) => n.key);

describe("no_owner", () => {
  it("fires at exactly the threshold, not a millisecond before", () => {
    const owned = { drafts: [draft({ status: "approved" })] };
    expect(keys({ ...owned, issues: [issue()] })).toEqual([
      "no_owner:issue-1:1",
    ]);
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
    ).toEqual(["no_owner:issue-1:1"]);
  });
});

describe("no_draft", () => {
  const owned = issue({ ownerSlackId: "U1" });

  it("fires when an old issue has no draft at all", () => {
    expect(keys({ issues: [owned] })).toEqual(["no_draft:issue-1:1"]);
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
      "draft_pending:draft-1:1",
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
    const sent = [
      { issueId: "issue-1", kind: "draft_pending:draft-1", sentAt: NOW },
    ];
    expect(keys({ issues: [owned], drafts, sent })).toEqual([
      "draft_pending:draft-2:1",
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
    ).toEqual(["customer_waiting:msg-1:1"]);
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
      "customer_waiting:msg-1:1",
    ]);
  });

  it("re-arms on a new customer message", () => {
    const messages = [
      message({ createdAt: ago(30 * 60_000) }),
      message({ id: "msg-2", direction: "agent", createdAt: ago(20 * 60_000) }),
      message({ id: "msg-3", createdAt: ago(10 * 60_000) }),
    ];
    const sent = [
      { issueId: "issue-1", kind: "customer_waiting:msg-1", sentAt: NOW },
    ];
    expect(keys({ issues: [owned], drafts: drafted, messages, sent })).toEqual([
      "customer_waiting:msg-3:1",
    ]);
  });

  it("stays silent on a message Jev already judged as needing no reply", () => {
    expect(skipKey("customer_waiting", "msg-1")).toBe(
      "skip:customer_waiting:msg-1",
    );
    expect(nudgeKey("customer_waiting", "msg-1", 3)).toBe(
      "customer_waiting:msg-1:3",
    );
    const sent = [
      {
        issueId: "issue-1",
        kind: skipKey("customer_waiting", "msg-1"),
        sentAt: NOW,
      },
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
      {
        issueId: "issue-1",
        kind: skipKey("customer_waiting", "msg-1"),
        sentAt: NOW,
      },
    ];
    const base = { issues: [owned], drafts: drafted, messages: [message()] };
    expect(keys({ ...base, sent: skipped, jevCheck: false })).toEqual([
      "customer_waiting:msg-1:1",
    ]);
    expect(
      keys({
        ...base,
        sent: [
          { issueId: "issue-1", kind: "customer_waiting:msg-1", sentAt: NOW },
        ],
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
    const sent = first.map((n) => ({
      issueId: n.issueId,
      kind: n.key,
      sentAt: NOW,
    }));
    expect(run({ issues, drafts, messages, sent })).toEqual([]);
  });

  it("dedups per issue: another issue's record does not silence this one", () => {
    const sent = [
      {
        issueId: "issue-2",
        kind: nudgeKey("no_owner", "issue-1", 1),
        sentAt: NOW,
      },
    ];
    expect(
      keys({
        issues: [issue()],
        drafts: [draft({ status: "approved" })],
        sent,
      }),
    ).toEqual(["no_owner:issue-1:1"]);
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
        "no_owner:issue-1:1",
        "no_draft:issue-1:1",
      ]);
    }
  });
});

describe("repeat rounds", () => {
  const H = 60 * 60_000;
  // Only no_owner holds: the approved draft silences no_draft.
  const base = { issues: [issue()], drafts: [draft({ status: "approved" })] };
  const sentAgo = (kind: string, ms: number) => ({
    issueId: "issue-1",
    kind,
    sentAt: ago(ms),
  });

  it("sends round 2 at exactly the first gap after round 1, not a millisecond before", () => {
    const at = [sentAgo("no_owner:issue-1:1", H)];
    expect(keys({ ...base, sent: at })).toEqual(["no_owner:issue-1:2"]);
    expect(run({ ...base, sent: at })[0]).toMatchObject({
      kind: "no_owner",
      refId: "issue-1",
      n: 2,
    });
    expect(
      keys({ ...base, sent: [sentAgo("no_owner:issue-1:1", H - 1)] }),
    ).toEqual([]);
  });

  it("reuses the last gap for every later round", () => {
    const sent = (ms: number) => [
      sentAgo("no_owner:issue-1:1", 10 * H),
      sentAgo("no_owner:issue-1:2", 9 * H),
      sentAgo("no_owner:issue-1:3", ms),
    ];
    expect(keys({ ...base, sent: sent(4 * H) })).toEqual([
      "no_owner:issue-1:4",
    ]);
    expect(keys({ ...base, sent: sent(4 * H - 1) })).toEqual([]);
    expect(
      keys({
        ...base,
        sent: [
          sentAgo("no_owner:issue-1:1", 10 * H),
          sentAgo("no_owner:issue-1:2", 4 * H),
        ],
      }),
    ).toEqual(["no_owner:issue-1:3"]);
  });

  it("with no repeat gaps, never sends a second round", () => {
    expect(
      keys({
        ...base,
        sent: [sentAgo("no_owner:issue-1:1", 100 * H)],
        repeatMinutes: [],
      }),
    ).toEqual([]);
  });

  it("stops once the condition clears, whatever the elapsed time", () => {
    const sent = [
      sentAgo("no_owner:issue-1:1", 100 * H),
      sentAgo("customer_waiting:msg-1:1", 100 * H),
    ];
    expect(
      keys({ ...base, issues: [issue({ ownerSlackId: "U1" })], sent }),
    ).toEqual([]);
    expect(
      keys({ ...base, issues: [issue({ status: "closed" })], sent }),
    ).toEqual([]);
    const answered = [
      message({ createdAt: ago(3 * H) }),
      message({ id: "msg-2", direction: "agent", createdAt: ago(2 * H) }),
    ];
    expect(
      keys({
        ...base,
        issues: [issue({ ownerSlackId: "U1" })],
        messages: answered,
        sent,
      }),
    ).toEqual([]);
    const owned = issue({ ownerSlackId: "U1" });
    const draftSent = [sentAgo("draft_pending:draft-1:1", 100 * H)];
    expect(
      keys({
        issues: [owned],
        drafts: [draft({ status: "approved" })],
        sent: draftSent,
      }),
    ).toEqual([]);
    expect(
      keys({
        issues: [{ ...owned, status: "on_hold" }],
        drafts: [draft()],
        messages: [message()],
        sent: [...draftSent, sentAgo("customer_waiting:msg-1:1", 100 * H)],
      }),
    ).toEqual([]);
  });

  it("restarts at round 1 on a new ref", () => {
    const owned = issue({ ownerSlackId: "U1" });
    const drafts = [
      draft({ id: "draft-1", status: "superseded", createdAt: ago(10 * H) }),
      draft({ id: "draft-2" }),
    ];
    expect(
      keys({
        issues: [owned],
        drafts,
        sent: [sentAgo("draft_pending:draft-1:3", 100 * H)],
      }),
    ).toEqual(["draft_pending:draft-2:1"]);
  });

  it("counts a key without a round as round 1", () => {
    expect(keys({ ...base, sent: [sentAgo("no_owner:issue-1", H)] })).toEqual([
      "no_owner:issue-1:2",
    ]);
    expect(
      keys({ ...base, sent: [sentAgo("no_owner:issue-1", H - 1)] }),
    ).toEqual([]);
  });

  it("a Jev skip silences every round of its message, unless the check is off", () => {
    const waiting = {
      issues: [issue({ ownerSlackId: "U1" })],
      drafts: [draft({ status: "approved" })],
      messages: [message({ createdAt: ago(3 * H) })],
      sent: [
        sentAgo("customer_waiting:msg-1:1", 2 * H),
        sentAgo(skipKey("customer_waiting", "msg-1"), H),
      ],
    };
    expect(keys(waiting)).toEqual([]);
    expect(keys({ ...waiting, jevCheck: false })).toEqual([
      "customer_waiting:msg-1:2",
    ]);
  });

  it("does not count another issue's rounds", () => {
    expect(
      keys({
        ...base,
        sent: [{ ...sentAgo("no_owner:issue-1:1", 0), issueId: "issue-2" }],
      }),
    ).toEqual(["no_owner:issue-1:1"]);
  });
});

describe("dueEscalations", () => {
  const MIN = 60_000;
  const LEVELS = { "desk-1": [5, 60] };
  const esc = (over: Partial<EscalationInput>) =>
    dueEscalations({
      issues: [],
      messages: [],
      sent: [],
      now: NOW,
      levels: LEVELS,
      ...over,
    });
  const onDesk = (over: Partial<IssueRow> = {}) =>
    issue({ deskId: "desk-1", ...over });

  it("fires level 1 at exactly its minutes, not a millisecond before", () => {
    expect(esc({ issues: [onDesk({ createdAt: ago(5 * MIN) })] })).toEqual([
      {
        issueId: "issue-1",
        deskId: "desk-1",
        level: 1,
        reasons: [{ kind: "no_owner", refId: "issue-1", minutes: 5 }],
        key: "escalate:1",
      },
    ]);
    expect(esc({ issues: [onDesk({ createdAt: ago(5 * MIN - 1) })] })).toEqual(
      [],
    );
  });

  it("returns only the highest level reached", () => {
    expect(
      esc({ issues: [onDesk({ createdAt: ago(61 * MIN) })] }).map((e) => e.key),
    ).toEqual([escalationKey(2)]);
  });

  it("a sent level never fires again, even for a condition that comes back; the next level still does", () => {
    const owned = onDesk({ ownerSlackId: "U1", createdAt: ago(30 * MIN) });
    const sent = [{ issueId: "issue-1", kind: "escalate:1" }];
    // A new waiting condition must not re-arm an escalation level already sent.
    const back = [message({ id: "msg-2", createdAt: ago(10 * MIN) })];
    expect(esc({ issues: [owned], messages: back, sent })).toEqual([]);
    const later = [message({ id: "msg-2", createdAt: ago(60 * MIN) })];
    expect(
      esc({ issues: [owned], messages: later, sent }).map((e) => e.key),
    ).toEqual(["escalate:2"]);
  });

  it("does not send a lower level after a higher one", () => {
    const sent = [{ issueId: "issue-1", kind: "escalate:2" }];
    expect(
      esc({ issues: [onDesk({ createdAt: ago(10 * MIN) })], sent }),
    ).toEqual([]);
  });

  it("names both conditions and ages the issue from the oldest", () => {
    const [e] = esc({
      issues: [onDesk({ createdAt: ago(70 * MIN) })],
      messages: [message({ createdAt: ago(3 * MIN) })],
    });
    expect(e.level).toBe(2);
    expect(e.reasons).toEqual([
      { kind: "no_owner", refId: "issue-1", minutes: 70 },
      { kind: "customer_waiting", refId: "msg-1", minutes: 3 },
    ]);
  });

  it("counts customer_waiting from the customer's last message", () => {
    const owned = onDesk({ ownerSlackId: "U1", createdAt: ago(90 * MIN) });
    expect(
      esc({
        issues: [owned],
        messages: [message({ createdAt: ago(6 * MIN) })],
      }).map((e) => e.reasons.map((r) => r.kind)),
    ).toEqual([["customer_waiting"]]);
    expect(
      esc({
        issues: [owned],
        messages: [
          message({ createdAt: ago(6 * MIN), ts: "1" }),
          message({
            id: "msg-2",
            direction: "agent",
            createdAt: ago(1 * MIN),
            ts: "2",
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("skips closed issues and issues without a triage card", () => {
    const old = ago(10 * MIN);
    expect(
      esc({
        issues: [
          onDesk({ status: "closed", createdAt: old }),
          onDesk({ id: "issue-2", triageRootTs: null, createdAt: old }),
        ],
      }),
    ).toEqual([]);
  });

  it("on hold keeps no_owner but not customer_waiting", () => {
    const [e] = esc({
      issues: [onDesk({ status: "on_hold", createdAt: ago(10 * MIN) })],
      messages: [message({ createdAt: ago(10 * MIN) })],
    });
    expect(e.reasons.map((r) => r.kind)).toEqual(["no_owner"]);
  });

  it("honours a Jev skip only with jevCheck on", () => {
    const input = {
      issues: [onDesk({ ownerSlackId: "U1", createdAt: ago(10 * MIN) })],
      messages: [message({ createdAt: ago(10 * MIN) })],
      sent: [
        { issueId: "issue-1", kind: skipKey("customer_waiting", "msg-1") },
      ],
    };
    expect(esc(input)).toEqual([]);
    expect(esc({ ...input, jevCheck: false }).map((e) => e.key)).toEqual([
      "escalate:1",
    ]);
  });

  it("a desk without levels never escalates; an issue without a desk uses the default desk", () => {
    const old = ago(10 * MIN);
    expect(
      esc({ issues: [issue({ deskId: "desk-2", createdAt: old })] }),
    ).toEqual([]);
    expect(esc({ issues: [issue({ deskId: null, createdAt: old })] })).toEqual(
      [],
    );
    expect(
      esc({
        issues: [issue({ deskId: null, createdAt: old })],
        defaultDeskId: "desk-1",
      }).map((e) => e.key),
    ).toEqual(["escalate:1"]);
  });
});

describe("with sla", () => {
  const min = 60_000;
  const owned = { ownerSlackId: "U0OWNER01" };
  const at = (now: Date, over: Partial<RuleInput>) =>
    keys({ now, sla: EXAMPLE_SLA, ...over });

  it("nudges an unowned urgent issue at its 15-minute target, not before", () => {
    const opened = new Date(NOW.getTime() - 14 * min);
    const input = {
      issues: [issue({ priority: "urgent", createdAt: opened })],
      drafts: [draft({ status: "approved" })],
    };
    expect(at(NOW, input)).toEqual([]);
    expect(at(new Date(opened.getTime() + 15 * min), input)).toEqual([
      "no_owner:issue-1:1",
    ]);
  });

  it("counts business minutes for a normal issue opened Friday afternoon", () => {
    // Fri 2026-10-02 16:30 New York (EDT); 480 business minutes end Mon 16:30.
    const input = {
      issues: [
        issue({
          ...owned,
          priority: "normal",
          createdAt: new Date("2026-10-02T20:30:00Z"),
        }),
      ],
    };
    expect(at(new Date("2026-10-05T20:29:00Z"), input)).toEqual([]);
    expect(at(new Date("2026-10-05T20:30:00Z"), input)).toEqual([
      "no_draft:issue-1:1",
    ]);
  });

  it("uses the next-response target once the team has replied", () => {
    const sla = {
      ...EXAMPLE_SLA,
      targets: {
        ...EXAMPLE_SLA.targets,
        urgent: {
          firstResponseMinutes: 15,
          nextResponseMinutes: 60,
          businessHours: false,
        },
      },
    };
    const asked = new Date(NOW.getTime() - 30 * min);
    const input = {
      sla,
      issues: [issue({ ...owned, priority: "urgent" })],
      drafts: [draft({ status: "approved" })],
      messages: [
        message({ id: "reply", direction: "agent", ts: "1.0" }),
        message({ id: "again", ts: "2.0", createdAt: asked }),
      ],
    };
    expect(at(NOW, input)).toEqual([]);
    expect(at(new Date(asked.getTime() + 60 * min), input)).toEqual([
      "customer_waiting:again:1",
    ]);
  });

  it("starts draft_pending at the draft, not at the issue", () => {
    const drafted = new Date(NOW.getTime() - 10 * min);
    const input = {
      issues: [
        issue({
          ...owned,
          priority: "urgent",
          createdAt: new Date(NOW.getTime() - 86_400_000),
        }),
      ],
      drafts: [draft({ createdAt: drafted })],
    };
    expect(at(NOW, input)).toEqual([]);
    expect(at(new Date(drafted.getTime() + 15 * min), input)).toEqual([
      "draft_pending:draft-1:1",
    ]);
  });
});

describe("nudgeRounds (when each next round comes due)", () => {
  const rounds = (over: Partial<RuleInput>) =>
    nudgeRounds({
      issues: [],
      drafts: [],
      messages: [],
      sent: [],
      now: NOW,
      minutes: MINUTES,
      repeatMinutes: [60, 240],
      ...over,
    }).map((n) => [n.key, n.dueAt.toISOString()]);

  it("dates a fresh condition at its threshold, due or not", () => {
    const fresh = ago(60_000);
    expect(rounds({ issues: [issue({ createdAt: fresh })] })).toEqual([
      [
        "no_owner:issue-1:1",
        new Date(fresh.getTime() + AT_THRESHOLD).toISOString(),
      ],
      [
        "no_draft:issue-1:1",
        new Date(fresh.getTime() + AT_THRESHOLD).toISOString(),
      ],
    ]);
  });

  it("dates a repeat round at the later of the threshold and the gap after the last round", () => {
    const sentAt = ago(10 * 60_000);
    expect(
      rounds({
        issues: [issue({ ownerSlackId: "U1" })],
        drafts: [draft()],
        sent: [
          { issueId: "issue-1", kind: "draft_pending:draft-1:1", sentAt },
          { issueId: "issue-1", kind: "draft_pending:draft-1:2", sentAt },
        ],
      }),
    ).toEqual([
      [
        "draft_pending:draft-1:3",
        new Date(sentAt.getTime() + 240 * 60_000).toISOString(),
      ],
    ]);
  });

  it("dates nothing once the rounds run out, after a no-reply verdict, or on hold", () => {
    expect(
      rounds({
        issues: [issue({ ownerSlackId: "U1" })],
        drafts: [draft({ status: "approved" })],
        repeatMinutes: [],
        sent: [{ issueId: "issue-1", kind: "no_owner:issue-1:1", sentAt: NOW }],
      }),
    ).toEqual([]);
    expect(
      rounds({
        issues: [issue({ ownerSlackId: "U1" })],
        drafts: [draft({ status: "approved" })],
        messages: [message()],
        sent: [
          {
            issueId: "issue-1",
            kind: skipKey("customer_waiting", "msg-1"),
            sentAt: NOW,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      rounds({
        issues: [issue({ ownerSlackId: "U1", status: "on_hold" })],
        drafts: [draft()],
        messages: [message()],
      }),
    ).toEqual([]);
  });

  it("agrees with dueNudges at every instant", () => {
    const input = {
      issues: [issue({ createdAt: ago(3 * 60_000) })],
      drafts: [],
      messages: [message({ createdAt: ago(60_000) })],
      sent: [],
      minutes: MINUTES,
      repeatMinutes: [60],
    };
    for (const offset of [
      0,
      2 * 60_000 - 1,
      2 * 60_000,
      4 * 60_000,
      70 * 60_000,
    ]) {
      const now = new Date(NOW.getTime() + offset);
      const due = nudgeRounds({ ...input, now })
        .filter((n) => n.dueAt.getTime() <= now.getTime())
        .map((n) => n.key);
      expect(due).toEqual(dueNudges({ ...input, now }).map((n) => n.key));
    }
  });
});

describe("escalationTimes", () => {
  const base: EscalationInput = {
    issues: [issue({ createdAt: ago(10 * 60_000) })],
    messages: [],
    sent: [],
    now: NOW,
    levels: { "desk-1": [5, 60] },
    defaultDeskId: "desk-1",
  };

  it("dates the first unsent level from the oldest holding condition", () => {
    expect(escalationTimes(base)).toEqual([
      {
        issueId: "issue-1",
        dueAt: new Date(ago(10 * 60_000).getTime() + 5 * 60_000),
      },
    ]);
    expect(
      escalationTimes({
        ...base,
        sent: [{ issueId: "issue-1", kind: escalationKey(1) }],
      }),
    ).toEqual([
      {
        issueId: "issue-1",
        dueAt: new Date(ago(10 * 60_000).getTime() + 60 * 60_000),
      },
    ]);
  });

  it("dates nothing after the last level, for a desk with nobody to notify, or with no condition", () => {
    expect(
      escalationTimes({
        ...base,
        sent: [{ issueId: "issue-1", kind: escalationKey(2) }],
      }),
    ).toEqual([]);
    expect(escalationTimes(base, new Set(["desk-1"]))).toEqual([]);
    expect(
      escalationTimes({ ...base, issues: [issue({ ownerSlackId: "U1" })] }),
    ).toEqual([]);
  });
});
