import { describe, expect, it } from "vitest";

import type { AttachedTrigger, ReceiptFire, ReceiptSummary } from "./logic";
import {
  AGENTS,
  costOf,
  costSummary,
  cuesFromReplay,
  dispatchDelays,
  parseWindow,
  percentile,
  summarizeLatencies,
  failedFleetReceipts,
  fleetWideKeys,
  isOn,
  linearIssueUrl,
  latencies,
  planSwitch,
  receiptView,
  redact,
  replayPlan,
  secondsBetween,
  slackTsToMs,
  triggerStates,
} from "./logic";

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
      "urgent-pager",
    ]);
  });

  it("fleet-wide pause and resume leave urgent-pager alone", () => {
    expect(fleetWideKeys()).toEqual([
      "intake",
      "copilot",
      "escalation",
      "controller",
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

  it("computes each leg of the timeline", () => {
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
    triggerSlugs: ["sylon-copilot", "backlog-nudge"],
    failedTriggerSlugs,
  });

  it("keeps receipts whose failed delivery went to a Sylon agent", () => {
    const out = failedFleetReceipts([
      r("1", 1, ["sylon-copilot"]),
      r("2", 1, ["backlog-nudge"]),
      r("3", 0, []),
    ]);
    expect(out.map((x) => x.id)).toEqual(["1"]);
  });

  it("shows the page no sender detail", () => {
    const raw = { ...r("1", 1, ["sylon-copilot"]), ip: "10.0.0.1" };
    expect(receiptView(raw)).toEqual({
      id: "1",
      eventType: "issue.created",
      receivedAt: "2026-10-02T07:00:00.000Z",
      failed: 1,
      failedTriggerSlugs: ["sylon-copilot"],
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
      definitionSlug: "sylon-escalation",
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

  it("refuses a receipt with no Sylon fire", () => {
    expect(replayPlan([fire("1", "backlog-nudge", "failed")])).toEqual({
      ok: false,
      status: 403,
      reason: "not a Sylon receipt",
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
        fire("2", "sylon-copilot", "failed"),
        fire("3", "sylon-intake", "succeeded"),
        fire("4", "sylon-intake", "claimed", true),
        fire("5", "sylon-intake", "claimed"),
      ]),
    ).toEqual({ ok: true, fireIds: ["2", "4"] });
  });

  it("has nothing to do when every Sylon fire succeeded", () => {
    expect(replayPlan([fire("3", "sylon-intake", "succeeded")])).toMatchObject({
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
        "https://linear.app/acme/project/sylon-issues-9fa8692f54ff",
        "SAP-3723",
      ),
    ).toBe("https://linear.app/acme/issue/SAP-3723");
    expect(linearIssueUrl(null, "SAP-1")).toBeNull();
    expect(linearIssueUrl("https://example.com/x", "SAP-1")).toBeNull();
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

  it("times dispatch for fleet fires that have started", () => {
    const fire = (
      slug: string,
      startedAt: string | null,
      where = "execution",
    ) =>
      ({
        trigger: { definitionSlug: slug },
        [where]: startedAt ? { startedAt } : null,
      }) as never;
    const slug = AGENTS[0]!.slug;
    expect(
      dispatchDelays("2026-10-01T10:00:00Z", [
        fire(slug, "2026-10-01T10:00:02.5Z"),
        fire(slug, "2026-10-01T10:00:04Z", "run"),
        fire(slug, null),
        fire("someone-elses-agent", "2026-10-01T10:00:09Z"),
        fire(slug, "2026-10-01T09:59:00Z"),
      ]),
    ).toEqual([2.5, 4]);
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
    expect(s.pylonUsdPerTicket).toBe(3);
    expect(costSummary([]).meanUsd).toBeNull();
  });
});
