import { describe, expect, it } from "vitest";

import { ConfigSchemas, setConfig } from "./config";
import { memoryDb } from "./db";
import { ensureAccount, openIssue } from "./issues";
import {
  addBusinessMinutes,
  issueSla,
  slaDue,
  type BusinessHours,
  type SlaMessage,
} from "./sla";
import { EXAMPLE_SLA } from "./test-ctx";

const NY: BusinessHours = EXAMPLE_SLA.businessHours;
const SLA = EXAMPLE_SLA;

// October 2026 is EDT (UTC-4): Mon 2026-10-05 10:00 New York is 14:00Z.
const ny = (iso: string) => new Date(`${iso}-04:00`);
const add = (iso: string, minutes: number, hours = NY) =>
  addBusinessMinutes(ny(iso), minutes, hours).toISOString();

describe("sla schema", () => {
  const schema = ConfigSchemas.sla;
  const withHours = (h: Partial<BusinessHours>) => ({
    ...SLA,
    businessHours: { ...NY, ...h },
  });

  it("accepts the README example", () => {
    expect(schema.parse(SLA)).toEqual(SLA);
  });

  it("rejects an unknown zone, a short or inverted window, and bad days", () => {
    expect(
      schema.safeParse(withHours({ timeZone: "Mars/Olympus" })).success,
    ).toBe(false);
    expect(schema.safeParse(withHours({ end: "09:59" })).success).toBe(false);
    expect(schema.safeParse(withHours({ start: "17:00" })).success).toBe(false);
    expect(schema.safeParse(withHours({ start: "9:00" })).success).toBe(false);
    expect(schema.safeParse(withHours({ days: [] })).success).toBe(false);
    expect(schema.safeParse(withHours({ days: [1, 1] })).success).toBe(false);
    expect(schema.safeParse(withHours({ days: [7] })).success).toBe(false);
    expect(schema.safeParse(withHours({ end: "10:00" })).success).toBe(true);
  });

  it("rejects a missing priority and minutes outside 1..10080", () => {
    const { low: _low, ...three } = SLA.targets;
    expect(schema.safeParse({ ...SLA, targets: three }).success).toBe(false);
    for (const minutes of [0, 10081, 1.5]) {
      const targets = {
        ...SLA.targets,
        urgent: { ...SLA.targets.urgent, firstResponseMinutes: minutes },
      };
      expect(schema.safeParse({ ...SLA, targets }).success).toBe(false);
    }
  });
});

describe("addBusinessMinutes", () => {
  it("counts inside the window", () => {
    expect(add("2026-10-05T10:00", 60)).toBe(
      ny("2026-10-05T11:00").toISOString(),
    );
  });

  it("carries past the end into the next business day", () => {
    expect(add("2026-10-05T16:30", 60)).toBe(
      ny("2026-10-06T09:30").toISOString(),
    );
  });

  it("skips the weekend", () => {
    expect(add("2026-10-09T16:30", 480)).toBe(
      ny("2026-10-12T16:30").toISOString(),
    );
    expect(add("2026-10-10T12:00", 30)).toBe(
      ny("2026-10-12T09:30").toISOString(),
    );
  });

  it("starts the clock at the window when it starts before it", () => {
    expect(add("2026-10-05T07:00", 30)).toBe(
      ny("2026-10-05T09:30").toISOString(),
    );
  });

  it("returns the start for 0 minutes inside a window", () => {
    expect(add("2026-10-05T10:00", 0)).toBe(
      ny("2026-10-05T10:00").toISOString(),
    );
  });

  it("keeps local time across the DST start", () => {
    // Fri 2027-03-12 16:30 EST; clocks go forward on Sun 2027-03-14.
    const out = addBusinessMinutes(new Date("2027-03-12T21:30:00Z"), 60, NY);
    expect(out.toISOString()).toBe("2027-03-15T13:30:00.000Z");
  });

  it("keeps local time across the DST end", () => {
    // Fri 2026-10-30 16:30 EDT; clocks go back on Sun 2026-11-01.
    const out = addBusinessMinutes(new Date("2026-10-30T20:30:00Z"), 60, NY);
    expect(out.toISOString()).toBe("2026-11-02T14:30:00.000Z");
  });

  it("counts the minutes that pass in a window holding the DST start", () => {
    // Sun 2027-03-14 01:00-04:00 New York: 02:00 EST jumps to 03:00 EDT, so the window holds 120.
    const sunday: BusinessHours = {
      ...NY,
      days: [0],
      start: "01:00",
      end: "04:00",
    };
    const open = new Date("2027-03-14T06:00:00Z");
    expect(addBusinessMinutes(open, 120, sunday).toISOString()).toBe(
      "2027-03-14T08:00:00.000Z",
    );
    // The rest runs into the next Sunday, 01:00 + 60 = 02:00 EDT.
    expect(addBusinessMinutes(open, 180, sunday).toISOString()).toBe(
      "2027-03-21T06:00:00.000Z",
    );
  });

  it("counts the minutes that pass in a window holding the DST end", () => {
    // Sun 2026-11-01 01:00-04:00 New York: 02:00 EDT falls back to 01:00 EST, so it holds 240.
    const sunday: BusinessHours = {
      ...NY,
      days: [0],
      start: "01:00",
      end: "04:00",
    };
    const open = new Date("2026-11-01T05:00:00Z");
    expect(addBusinessMinutes(open, 240, sunday).toISOString()).toBe(
      "2026-11-01T09:00:00.000Z",
    );
    expect(addBusinessMinutes(open, 241, sunday).toISOString()).toBe(
      "2026-11-08T06:01:00.000Z",
    );
  });

  it("ends a window whose closing time is skipped at the DST start", () => {
    // Sun 2027-03-14 01:00-02:30 New York: 02:30 never happens, so the window holds 60.
    const sunday: BusinessHours = {
      ...NY,
      days: [0],
      start: "01:00",
      end: "02:30",
    };
    const open = new Date("2027-03-14T06:00:00Z");
    expect(addBusinessMinutes(open, 90, sunday).toISOString()).toBe(
      "2027-03-21T05:30:00.000Z",
    );
  });

  it("counts a window twice when the DST end repeats it", () => {
    // Sun 2026-11-01 01:00-01:30 New York happens in EDT, then again in EST.
    const sunday: BusinessHours = {
      ...NY,
      days: [0],
      start: "01:00",
      end: "01:30",
    };
    const open = new Date("2026-11-01T05:00:00Z");
    expect(addBusinessMinutes(open, 45, sunday).toISOString()).toBe(
      "2026-11-01T06:15:00.000Z",
    );
  });

  it("finishes the longest accepted case and throws past the step bound", () => {
    const weekly: BusinessHours = {
      ...NY,
      days: [3],
      start: "09:00",
      end: "10:00",
    };
    const out = addBusinessMinutes(ny("2026-10-05T10:00"), 10080, weekly);
    // 168 one-hour Wednesday windows: the last one ends 167 weeks after Wed 2026-10-07.
    const weeks = Math.round(
      (out.getTime() - ny("2026-10-07T10:00").getTime()) / (7 * 86_400_000),
    );
    expect(weeks).toBe(167);
    expect(() =>
      addBusinessMinutes(ny("2026-10-05T10:00"), 10080, weekly, 50),
    ).toThrow(/no result within 50 steps/);
  });
});

describe("slaDue", () => {
  const created = ny("2026-10-05T10:00");
  const msg = (
    direction: SlaMessage["direction"],
    minute: number,
  ): SlaMessage => {
    const at = new Date(created.getTime() + minute * 60_000);
    return { direction, ts: String(at.getTime() / 1000), createdAt: at };
  };
  const due = (
    messages: SlaMessage[],
    over: {
      status?: "new" | "on_you" | "on_customer" | "on_hold" | "closed";
      priority?: string | null;
    } = {},
  ) =>
    slaDue(
      {
        status: over.status ?? "new",
        priority: over.priority === undefined ? "urgent" : over.priority,
        createdAt: created,
        messages,
      },
      SLA,
    );

  it("runs the first-response clock from the issue's creation until the team replies", () => {
    expect(due([msg("customer", 0)])).toEqual({
      kind: "first_response",
      startedAt: created,
      dueAt: ny("2026-10-05T10:15"),
    });
  });

  it("runs the next-response clock from the customer's message after a reply", () => {
    const later = msg("customer", 30);
    expect(due([msg("customer", 0), msg("agent", 5), later])).toEqual({
      kind: "next_response",
      startedAt: later.createdAt,
      dueAt: new Date(later.createdAt.getTime() + 15 * 60_000),
    });
  });

  it("orders by Slack ts, not by insert time", () => {
    // Stored late, posted before the agent's reply: the team spoke last.
    const late = {
      ...msg("customer", 2),
      createdAt: msg("customer", 50).createdAt,
    };
    expect(due([msg("customer", 0), msg("agent", 5), late])).toBeNull();
  });

  it("stops when the team spoke last", () => {
    expect(due([msg("customer", 0), msg("agent", 5)])).toBeNull();
  });

  it("ignores internal messages", () => {
    expect(due([msg("customer", 0), msg("internal", 3)])?.kind).toBe(
      "first_response",
    );
    expect(
      due([msg("customer", 0), msg("agent", 5), msg("internal", 9)]),
    ).toBeNull();
  });

  it("stops for closed and on-hold issues", () => {
    expect(due([msg("customer", 0)], { status: "closed" })).toBeNull();
    expect(due([msg("customer", 0)], { status: "on_hold" })).toBeNull();
  });

  it("treats a null or unknown priority as normal, in business minutes", () => {
    const normal = ny("2026-10-06T10:00");
    expect(due([], { priority: null })?.dueAt).toEqual(normal);
    expect(due([], { priority: "p0" })?.dueAt).toEqual(normal);
  });

  it("counts wall-clock minutes when the target says so", () => {
    // Saturday: urgent ignores business hours.
    const sat = ny("2026-10-10T12:00");
    expect(
      slaDue(
        { status: "new", priority: "high", createdAt: sat, messages: [] },
        SLA,
      )?.dueAt,
    ).toEqual(ny("2026-10-10T13:00"));
  });
});

describe("issueSla", () => {
  it("is null without the sla key, and the running clock with it", async () => {
    const db = await memoryDb();
    const account = await ensureAccount(db, {
      name: "Acme",
      slackChannelId: "C0ACME",
    });
    const issue = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "urgent",
      title: "Down",
      customer: { channel: "C0ACME", ts: "1.0" },
    });
    expect(await issueSla(db, issue)).toBeNull();
    await setConfig(db, "sla", SLA, "test");
    const out = await issueSla(db, issue);
    expect(out?.kind).toBe("first_response");
    expect(out?.dueAt.getTime()).toBe(issue.createdAt.getTime() + 15 * 60_000);
  });
});
