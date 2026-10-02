import { describe, expect, it } from "vitest";

import { loadFixtures } from "../fixtures/index";
import {
  AllEvents,
  Events,
  SlackBlockActions,
  isEventType,
  type AnyEventType,
} from "./events";

const fixtures = loadFixtures();
/** A cron fire's stored input has no event schema; its agent's own test covers it. */
const events = fixtures.filter((f) => f.type !== "schedule_cron");

describe("fixtures", () => {
  it("loads every fixtures/<dir>/, agent fixtures included", () => {
    const dirs = new Set(fixtures.map((f) => f.file.split("/")[0]));
    for (const d of [
      "slack",
      "issue",
      "intake",
      "copilot",
      "escalation",
      "controller",
      "urgent-pager",
    ])
      expect(dirs).toContain(d);
    expect(fixtures.map((f) => f.file)).not.toContain("intake/jev.json");
  });

  it.each(events.map((f) => [f.file, f] as const))(
    "%s validates against its schema",
    (_file, f) => {
      expect(Object.keys(AllEvents)).toContain(f.type);
      const result = AllEvents[f.type as AnyEventType].safeParse(f.payload);
      expect(result.error?.issues).toBeUndefined();
    },
  );

  it("covers every domain event and every M1 button", () => {
    const types = new Set(fixtures.map((f) => f.type));
    for (const t of Object.keys(Events)) expect(types).toContain(t);
    const actionIds = fixtures
      .filter((f) => f.file.startsWith("slack/"))
      .filter((f) => f.type === "slack.block_actions")
      .map((f) => SlackBlockActions.parse(f.payload).actions[0].action_id);
    expect(actionIds.sort()).toEqual([
      "draft.approve",
      "draft.dismiss",
      "draft.escalate",
      "issue.close",
      "issue.take",
    ]);
  });

  it("has no token or response_url on a click", () => {
    for (const f of fixtures.filter((x) => x.type === "slack.block_actions")) {
      expect(f.payload).not.toHaveProperty("token");
      expect(f.payload).not.toHaveProperty("response_url");
    }
  });
});

describe("schemas", () => {
  it("are loose: unknown keys never fail a run", () => {
    const created = fixtures.find((f) => f.type === "issue.created")!;
    expect(
      Events["issue.created"].safeParse({ ...created.payload, addedLater: 1 })
        .success,
    ).toBe(true);
  });

  it("reject a payload without the envelope", () => {
    expect(
      Events["issue.created"].safeParse({
        category: "bug",
        priority: "low",
        title: "x",
      }).success,
    ).toBe(false);
  });

  it("isEventType knows only domain events", () => {
    expect(isEventType("issue.created")).toBe(true);
    expect(isEventType("slack.message.created")).toBe(false);
  });
});
