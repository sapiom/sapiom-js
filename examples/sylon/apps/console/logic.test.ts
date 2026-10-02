import { describe, expect, it } from "vitest";

import type { AttachedTrigger, ReceiptSummary } from "./logic";
import {
  AGENTS,
  checkSecret,
  failedFleetReceipts,
  fleetWideKeys,
  isOn,
  latencies,
  planSwitch,
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
});

describe("route guard", () => {
  it("accepts only the exact secret", () => {
    expect(checkSecret("s3cret-value", "s3cret-value")).toBe("ok");
    expect(checkSecret("s3cret-value", "s3cret-valuf")).toBe("denied");
    expect(checkSecret("s3cret-value", "short")).toBe("denied");
    expect(checkSecret("s3cret-value", undefined)).toBe("denied");
    expect(checkSecret("s3cret-value", ["s3cret-value"])).toBe("denied");
  });

  it("fails closed when no secret is configured", () => {
    expect(checkSecret(undefined, "anything")).toBe("unset");
    expect(checkSecret("", "")).toBe("unset");
  });
});
