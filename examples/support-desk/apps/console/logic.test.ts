import { describe, expect, it } from "vitest";

import type { AttachedTrigger, ReceiptFire, ReceiptSummary } from "./logic";
import {
  AGENTS,
  boardSla,
  costOf,
  costSummary,
  cuesFromReplay,
  draftTimes,
  pageReceipts,
  parseWindow,
  percentile,
  summarizeLatencies,
  ticketsPerDay,
  failedFleetReceipts,
  fleetWideKeys,
  isOn,
  linearIssueUrl,
  KB_BODY_MAX,
  KB_TITLE_MAX,
  latencies,
  parseKbInput,
  pickDesk,
  planSwitch,
  receiptView,
  redact,
  replayPlan,
  scopeReceipts,
  secondsBetween,
  slackTsToMs,
  triggerBody,
  triggerStates,
  slaLabel,
} from "./logic";
import { agentSlug } from "../../_shared/fleet-id";
import { EXAMPLE_SLA } from "../../_shared/test-ctx";

const ev = (
  id: string,
  eventType: string,
  status = "active",
): AttachedTrigger => ({ id, kind: "event", status, eventType, cron: null });
const cron = (id: string, c: string, status = "active"): AttachedTrigger => ({
  id,
  kind: "schedule_cron",
  status,
  eventType: null,
  cron: c,
});

const INTAKE_ALL = [
  ev("1", "slack.message.created"),
  ev("2", "slack.reaction_added"),
  ev("3", "slack.block_actions"),
];

describe("fleet agents", () => {
  it("are fleet.json's projects without the smoke pair", () => {
    expect(AGENTS.map((a) => a.key)).toEqual([
      "intake",
      "copilot",
      "escalation",
      "controller",
      "linear-sync",
      "urgent-pager",
      "watchdog",
      "digest",
    ]);
  });

  it("fleet-wide pause and resume leave urgent-pager alone", () => {
    expect(fleetWideKeys()).toEqual([
      "intake",
      "copilot",
      "escalation",
      "controller",
      "linear-sync",
      "watchdog",
      "digest",
    ]);
  });
});

describe("trigger diffing", () => {
  it("is on only when every listed trigger is attached and active", () => {
    expect(isOn("intake", INTAKE_ALL)).toBe(true);
    expect(isOn("intake", INTAKE_ALL.slice(0, 2))).toBe(false);
    expect(
      isOn("intake", [
        ...INTAKE_ALL.slice(0, 2),
        ev("3", "slack.block_actions", "paused"),
      ]),
    ).toBe(false);
    expect(isOn("controller", [cron("9", "*/2 * * * *")])).toBe(true);
    expect(isOn("controller", [cron("9", "*/5 * * * *")])).toBe(false);
  });

  it("matches the digest's cron only in its zone, a missing zone meaning UTC", () => {
    const pacific = {
      ...cron("5", "0 9 * * *"),
      timezone: "America/Los_Angeles",
    };
    expect(isOn("digest", [pacific])).toBe(true);
    expect(isOn("digest", [cron("5", "0 9 * * *")])).toBe(false);
    expect(isOn("digest", [{ ...pacific, timezone: "UTC" }])).toBe(false);
    expect(
      isOn("controller", [{ ...cron("6", "*/2 * * * *"), timezone: "UTC" }]),
    ).toBe(true);
    expect(planSwitch("digest", true, [cron("5", "0 9 * * *")]).create).toEqual(
      [
        {
          project: "digest",
          kind: "schedule_cron",
          cron: "0 9 * * *",
          timezone: "America/Los_Angeles",
        },
      ],
    );
    expect(
      triggerBody({
        project: "digest",
        kind: "schedule_cron",
        cron: "0 9 * * *",
        timezone: "America/Los_Angeles",
      }),
    ).toEqual({
      kind: "schedule_cron",
      cron: "0 9 * * *",
      timezone: "America/Los_Angeles",
    });
    expect(
      triggerBody({
        project: "controller",
        kind: "schedule_cron",
        cron: "*/2 * * * *",
      }),
    ).toEqual({ kind: "schedule_cron", cron: "*/2 * * * *" });
    expect(triggerStates("digest", [])).toEqual([
      {
        label: "cron 0 9 * * * America/Los_Angeles",
        state: "missing",
        id: null,
      },
    ]);
  });

  it("treats a disabled trigger as deleted", () => {
    expect(
      triggerStates("escalation", [ev("7", "issue.escalate", "disabled")]),
    ).toEqual([{ label: "issue.escalate", state: "missing", id: null }]);
  });

  it("switching on creates the missing triggers and resumes paused ones", () => {
    const plan = planSwitch("intake", true, [
      ev("1", "slack.message.created"),
      ev("2", "slack.reaction_added", "paused"),
      ev("4", "slack.other"),
    ]);
    expect(plan).toEqual({
      create: [
        { project: "intake", kind: "event", eventType: "slack.block_actions" },
      ],
      resume: ["2"],
      remove: [],
    });
    expect(planSwitch("intake", true, INTAKE_ALL)).toEqual({
      create: [],
      resume: [],
      remove: [],
    });
  });

  it("switching off deletes only the triggers fleet.json lists, duplicates included", () => {
    const plan = planSwitch("controller", false, [
      cron("8", "*/2 * * * *"),
      cron("9", "*/2 * * * *", "paused"),
      cron("10", "0 * * * *"),
    ]);
    expect(plan).toEqual({ create: [], resume: [], remove: ["8", "9"] });
  });

  it("never plans a smoke trigger", () => {
    expect(planSwitch("smoke-ingest", true, [])).toEqual({
      create: [],
      resume: [],
      remove: [],
    });
  });
});

describe("latency", () => {
  it("reads Slack ts as epoch seconds", () => {
    expect(slackTsToMs("1790889355.981329")).toBe(1790889355981);
    expect(slackTsToMs(null)).toBeNull();
    expect(slackTsToMs("not a ts")).toBeNull();
  });

  it("rounds to one decimal and keeps missing ends null", () => {
    expect(secondsBetween(1000, 13_449)).toBe(12.4);
    expect(secondsBetween(1000, 13_450)).toBe(12.5);
    expect(secondsBetween(null, 5)).toBeNull();
  });

  it("computes each latency leg", () => {
    const created = new Date(1_790_889_360_000);
    expect(
      latencies({
        customerTs: "1790889355.981329",
        triageRootTs: "1790889362.100200",
        issueCreatedAt: created,
        draftCreatedAt: new Date(1_790_889_371_250),
        draftCardTs: "1790889372.400100",
      }),
    ).toEqual({
      messageToCard: 6.1,
      issueToDraft: 11.3,
      issueToDraftCard: 12.4,
      messageToDraftCard: 16.4,
    });
    expect(
      latencies({
        customerTs: "1790889355.981329",
        triageRootTs: null,
        issueCreatedAt: created.toISOString(),
        draftCreatedAt: null,
        draftCardTs: null,
      }),
    ).toEqual({
      messageToCard: null,
      issueToDraft: null,
      issueToDraftCard: null,
      messageToDraftCard: null,
    });
  });

  it("drops a leg that ends before it starts", () => {
    expect(
      latencies({
        customerTs: "1790889400.000100",
        triageRootTs: "1790889362.100200",
        issueCreatedAt: new Date(1_790_889_360_000),
        draftCreatedAt: null,
        draftCardTs: "1790889372.400100",
      }),
    ).toMatchObject({
      messageToCard: null,
      issueToDraftCard: 12.4,
      messageToDraftCard: null,
    });
  });
});

describe("failed receipts", () => {
  const r = (
    id: string,
    failed: number,
    failedTriggerSlugs: string[],
  ): ReceiptSummary => ({
    id,
    eventType: "issue.created",
    externalEventId: `issue.created:${id}`,
    outcome: "matched",
    receivedAt: "2026-10-02T07:00:00.000Z",
    deliveries: { total: 2, failed },
    triggerSlugs: [agentSlug("copilot"), "backlog-nudge"],
    failedTriggerSlugs,
  });

  it("keeps receipts whose failed delivery went to a fleet agent", () => {
    const out = failedFleetReceipts([
      r("1", 1, [agentSlug("copilot")]),
      r("2", 1, ["backlog-nudge"]),
      r("3", 0, []),
    ]);
    expect(out.map((x) => x.id)).toEqual(["1"]);
  });

  it("shows the page no sender detail", () => {
    const raw = { ...r("1", 1, [agentSlug("copilot")]), ip: "10.0.0.1" };
    expect(receiptView(raw)).toEqual({
      id: "1",
      eventType: "issue.created",
      receivedAt: "2026-10-02T07:00:00.000Z",
      failed: 1,
      failedTriggerSlugs: [agentSlug("copilot")],
    });
  });
});

describe("scoping", () => {
  it("never plans for a definition outside the fleet", () => {
    for (const key of ["backlog-nudge", "smoke-ingest", "smoke-consume"])
      expect(planSwitch(key, false, [ev("1", "slack.block_actions")])).toEqual({
        create: [],
        resume: [],
        remove: [],
      });
  });

  it("ignores a listed trigger that belongs to another definition", () => {
    const foreign = {
      ...ev("9", "issue.escalate"),
      definitionSlug: "backlog-nudge",
    };
    expect(planSwitch("escalation", false, [foreign]).remove).toEqual([]);
    expect(planSwitch("escalation", true, [foreign]).create).toHaveLength(1);
    const own = {
      ...ev("8", "issue.escalate"),
      definitionSlug: agentSlug("escalation"),
    };
    expect(planSwitch("escalation", false, [own, foreign]).remove).toEqual([
      "8",
    ]);
  });

  const fire = (
    id: string,
    slug: string,
    state: string,
    stale = false,
  ): ReceiptFire => ({ id, state, stale, trigger: { definitionSlug: slug } });

  it("refuses a receipt with no fleet fire", () => {
    expect(replayPlan([fire("1", "backlog-nudge", "failed")])).toEqual({
      ok: false,
      status: 403,
      reason: "not a fleet receipt",
    });
    expect(replayPlan([])).toMatchObject({ ok: false, status: 403 });
    expect(
      replayPlan([{ id: "2", state: "failed", trigger: null }]),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("replays only the failed fires on fleet slugs", () => {
    expect(
      replayPlan([
        fire("1", "backlog-nudge", "failed"),
        fire("2", agentSlug("copilot"), "failed"),
        fire("3", agentSlug("intake"), "succeeded"),
        fire("4", agentSlug("intake"), "claimed", true),
        fire("5", agentSlug("intake"), "claimed"),
      ]),
    ).toEqual({ ok: true, fireIds: ["2", "4"] });
  });

  it("has nothing to do when every fleet fire succeeded", () => {
    expect(
      replayPlan([fire("3", agentSlug("intake"), "succeeded")]),
    ).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("redacts the key from error text", () => {
    expect(
      redact("bad key sk_live_abc and sk_live_abc", ["sk_live_abc", undefined]),
    ).toBe("bad key [redacted] and [redacted]");
  });
});

describe("linear links", () => {
  it("builds an issue URL from the project's workspace", () => {
    expect(
      linearIssueUrl(
        "https://linear.app/acme/project/support-issues-9fa8692f54ff",
        "ENG-123",
      ),
    ).toBe("https://linear.app/acme/issue/ENG-123");
    expect(linearIssueUrl(null, "ENG-1")).toBeNull();
    expect(linearIssueUrl("https://example.com/x", "ENG-1")).toBeNull();
  });
});

describe("cues", () => {
  it("are labelled from the replay script's step ids", () => {
    const cues = cuesFromReplay({
      prefix: "[t]",
      steps: [
        { id: "bug", text: "a", expect: "x" },
        { id: "follow-up", threadOf: "bug", text: "b", expect: "y" },
      ],
    });
    expect(cues.prefix).toBe("[t]");
    expect(cues.steps.map((c) => c.label)).toEqual([
      "Bug",
      "Follow up (reply in the bug thread)",
    ]);
  });
});

describe("metrics", () => {
  it("takes nearest-rank percentiles and ignores missing values", () => {
    const v = [5, 1, null, 3, 2, 4, 10, 9, 8, 7, 6];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([null], 90)).toBeNull();
  });

  it("parses the window, defaulting to 24h and refusing others", () => {
    expect(parseWindow(null)).toBe("24h");
    expect(parseWindow("7d")).toBe("7d");
    expect(parseWindow("30d")).toBeNull();
  });

  it("summarizes each latency leg across issues", () => {
    const leg = (m: number | null, d: number | null) => ({
      messageToCard: m,
      issueToDraft: null,
      issueToDraftCard: d,
      messageToDraftCard: m === null || d === null ? null : m + d,
    });
    const s = summarizeLatencies([leg(1, 10), leg(3, 20), leg(null, 30)]);
    expect(s.messageToCard).toEqual({ n: 2, p50: 1, p90: 3 });
    expect(s.issueToDraftCard.p50).toBe(20);
    expect(s.messageToDraftCard.n).toBe(2);
  });

  it("counts tickets per 24-hour bucket back from now, oldest first", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(
      ticketsPerDay(
        [
          "2026-10-07T11:00:00Z",
          "2026-10-07T01:00:00Z",
          "2026-10-05T12:30:00Z",
          "2026-09-20T00:00:00Z",
          "2026-10-08T00:00:00Z",
        ],
        now,
        3,
      ),
    ).toEqual([0, 1, 2]);
  });

  it("reads spend as numbers whether the API sends strings or numbers", () => {
    expect(
      costOf({
        totalUsd: "0.42",
        llm: { listUsd: 0.3 },
        capability: { totalUsd: "0.12" },
        compute: { sandboxSeconds: 90 },
      }),
    ).toEqual({
      usd: 0.42,
      llmUsd: 0.3,
      capabilityUsd: 0.12,
      sandboxSeconds: 90,
    });
    expect(costOf({ totalUsd: 1 })).toEqual({
      usd: 1,
      llmUsd: 0,
      capabilityUsd: 0,
      sandboxSeconds: 0,
    });
  });

  it("prices only tickets with a counted run", () => {
    const t = (usd: number, runsCounted: number) => ({
      usd,
      llmUsd: usd / 2,
      capabilityUsd: usd / 4,
      sandboxSeconds: 10,
      runsCounted,
      runsMissing: 0,
    });
    const s = costSummary([t(1, 2), t(3, 1), t(100, 0)]);
    expect(s.tickets).toBe(2);
    expect(s.unpriced).toBe(1);
    expect(s.meanUsd).toBe(2);
    expect(s.p90Usd).toBe(3);
    expect(s.totalUsd).toBe(4);
    expect(s.llmUsd).toBe(2);
    expect(s.capabilityUsd).toBe(1);
    expect(s.meanSandboxSeconds).toBe(10);
    expect(s.targetUsdPerTicket).toBe(3);
    expect(costSummary([]).meanUsd).toBeNull();
  });
});

describe("parseKbInput", () => {
  const ok = { kind: "policy", title: "  Refunds ", body: "Never promise." };

  it("creates from kind, title and body, trimmed, enabled optional", () => {
    expect(parseKbInput(ok, "create")).toEqual({
      ok: true,
      value: { kind: "policy", title: "Refunds", body: "Never promise." },
    });
    expect(parseKbInput({ ...ok, enabled: false }, "create")).toMatchObject({
      ok: true,
      value: { enabled: false },
    });
  });

  it.each([
    [{ ...ok, kind: undefined }, "kind is required"],
    [{ ...ok, title: undefined }, "title is required"],
    [{ ...ok, body: undefined }, "body is required"],
    [{ ...ok, kind: "memo" }, "kind must be policy or answer"],
    [{ ...ok, title: "   " }, "title must be non-empty text"],
    [{ ...ok, body: 5 }, "body must be non-empty text"],
    [{ ...ok, enabled: "yes" }, "enabled must be true or false"],
    [{ ...ok, title: "t".repeat(KB_TITLE_MAX + 1) }, "title is over"],
    [{ ...ok, body: "b".repeat(KB_BODY_MAX + 1) }, "body is over"],
  ])("rejects an invalid create body (%#)", (body, message) => {
    const out = parseKbInput(body as Record<string, unknown>, "create");
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toContain(message);
  });

  it.each([[null], [[]], ["x"], [5]])(
    "rejects a body that is not a JSON object (%j)",
    (body) => {
      expect(parseKbInput(body, "create")).toEqual({
        ok: false,
        error: "body must be a JSON object",
      });
      expect(parseKbInput(body, "update")).toMatchObject({ ok: false });
    },
  );

  it("update takes any subset but not nothing, and ignores other keys", () => {
    expect(parseKbInput({ enabled: false }, "update")).toEqual({
      ok: true,
      value: { enabled: false },
    });
    expect(parseKbInput({ id: "x", updated_by: "me" }, "update")).toEqual({
      ok: false,
      error: "nothing to update",
    });
    expect(parseKbInput({ title: "" }, "update")).toMatchObject({ ok: false });
  });
});

describe("pageReceipts", () => {
  const receipt = (id: number, receivedAt: string) =>
    ({ id: String(id), receivedAt }) as ReceiptSummary;
  const source = (total: number) => async (offset: number, limit: number) =>
    Array.from(
      { length: Math.max(0, Math.min(limit, total - offset)) },
      (_, i) => receipt(offset + i, "2026-10-01T00:00:00Z"),
    );

  it("reads every page until a short one", async () => {
    const out = await pageReceipts(source(25), { pageSize: 10 });
    expect(out.receipts).toHaveLength(25);
    expect(out.truncated).toBe(false);
  });

  it("stops at the page cap and flags truncation", async () => {
    const out = await pageReceipts(source(100), { pageSize: 10, maxPages: 3 });
    expect(out.receipts).toHaveLength(30);
    expect(out.truncated).toBe(true);
  });

  it("stops once a page crosses the window boundary", async () => {
    let calls = 0;
    const out = await pageReceipts(
      async (offset, limit) => {
        calls++;
        return Array.from({ length: limit }, (_, i) =>
          receipt(
            offset + i,
            offset === 0 ? "2026-10-01T00:00:00Z" : "2026-09-01T00:00:00Z",
          ),
        );
      },
      { pageSize: 2, since: Date.parse("2026-09-15T00:00:00Z") },
    );
    expect(calls).toBe(2);
    expect(out.truncated).toBe(false);
  });
});

describe("draftTimes", () => {
  const created = new Date("2026-10-01T10:00:00Z");
  it("takes card time from the first posted draft and creation from the first row", () => {
    const out = draftTimes([
      { created_at: created, card_ts: null },
      {
        created_at: new Date("2026-10-01T10:02:00Z"),
        card_ts: "1790000100.000100",
      },
      {
        created_at: new Date("2026-10-01T10:03:00Z"),
        card_ts: "1790000200.000100",
      },
    ]);
    expect(out.draftCreatedAt).toBe(created);
    expect(out.draftCardTs).toBe("1790000100.000100");
  });

  it("returns nulls with no drafts", () => {
    expect(draftTimes([])).toEqual({ draftCreatedAt: null, draftCardTs: null });
  });
});

describe("pickDesk", () => {
  const desks = [
    { slug: "test", isDefault: false },
    { slug: "support", isDefault: true },
  ];

  it("takes the named desk, else the default desk", () => {
    expect(pickDesk(desks, "test")).toEqual({ ok: true, desk: desks[0] });
    expect(pickDesk(desks, null)).toEqual({ ok: true, desk: desks[1] });
    expect(pickDesk([desks[0]!], null)).toEqual({ ok: true, desk: desks[0] });
  });

  it("refuses an unknown slug rather than showing another desk, and an empty list", () => {
    expect(pickDesk(desks, "nope")).toEqual({
      ok: false,
      status: 404,
      reason: "no desk 'nope'",
    });
    expect(pickDesk([], null)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("scopeReceipts", () => {
  const receipts = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];
  const owners = new Map<string, string | null>([
    ["1", "desk-a"],
    ["2", "desk-b"],
    ["3", null],
  ]);

  it("keeps the desk's own receipts and the ones no desk can be named for", () => {
    expect(scopeReceipts(receipts, owners, "desk-a").map((r) => r.id)).toEqual([
      "1",
      "3",
      "4",
    ]);
    expect(scopeReceipts(receipts, owners, "desk-b").map((r) => r.id)).toEqual([
      "2",
      "3",
      "4",
    ]);
  });
});

describe("parseKbInput desk", () => {
  const ok = { kind: "policy", title: "T", body: "B" };
  const id = "a1b2c3d4-0000-4000-8000-0000000000a1";

  it("accepts a desk id or null (all desks), and rejects anything else", () => {
    expect(parseKbInput({ ...ok, deskId: id }, "create")).toMatchObject({
      ok: true,
      value: { deskId: id },
    });
    expect(parseKbInput({ ...ok, deskId: null }, "create")).toMatchObject({
      ok: true,
      value: { deskId: null },
    });
    expect(parseKbInput({ ...ok }, "create")).toMatchObject({
      ok: true,
      value: { kind: "policy" },
    });
    for (const deskId of ["test", 3, ""])
      expect(parseKbInput({ ...ok, deskId }, "create")).toMatchObject({
        ok: false,
      });
  });

  it("an update can move an article to all desks", () => {
    expect(parseKbInput({ deskId: null }, "update")).toEqual({
      ok: true,
      value: { deskId: null },
    });
  });
});

describe("SLA column", () => {
  const now = new Date("2026-10-05T14:00:00Z");
  const min = 60_000;
  const at = (m: number) => new Date(now.getTime() + m * min);

  it("labels time left and time past the deadline", () => {
    expect(slaLabel(null, now)).toBeNull();
    expect(slaLabel({ kind: "first_response", dueAt: at(12) }, now)).toBe(
      "first response in 12m",
    );
    expect(slaLabel({ kind: "next_response", dueAt: at(-5) }, now)).toBe(
      "next response breached 5m ago",
    );
    expect(slaLabel({ kind: "first_response", dueAt: at(125) }, now)).toBe(
      "first response in 2h 5m",
    );
    expect(slaLabel({ kind: "first_response", dueAt: at(-26 * 60) }, now)).toBe(
      "first response breached 1d 2h ago",
    );
  });

  it("gives each row its clock, and nulls without an sla", () => {
    const rows = [
      { id: "a", status: "new", priority: "urgent", createdAt: at(-3) },
      { id: "b", status: "on_customer", priority: "high", createdAt: at(-90) },
      { id: "c", status: "on_you", priority: "urgent", createdAt: at(-90) },
    ];
    const messages = [
      { issue_id: "b", direction: "customer", ts: "1.0", created_at: at(-90) },
      { issue_id: "b", direction: "agent", ts: "2.0", created_at: at(-80) },
      { issue_id: "c", direction: "agent", ts: "1.0", created_at: at(-80) },
      { issue_id: "c", direction: "customer", ts: "2.0", created_at: at(-20) },
    ];
    expect(boardSla(rows, messages, EXAMPLE_SLA, now)).toEqual([
      {
        slaKind: "first_response",
        slaDueAt: at(12).toISOString(),
        slaLabel: "first response in 12m",
      },
      { slaKind: null, slaDueAt: null, slaLabel: null },
      {
        slaKind: "next_response",
        slaDueAt: at(-5).toISOString(),
        slaLabel: "next response breached 5m ago",
      },
    ]);
    expect(boardSla(rows, messages, null, now)).toEqual(
      Array(3).fill({ slaKind: null, slaDueAt: null, slaLabel: null }),
    );
  });
});
