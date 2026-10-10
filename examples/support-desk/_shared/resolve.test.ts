import { describe, expect, it } from "vitest";

import {
  RESOLVE_DEFAULTS,
  idleCloseAt,
  idleReason,
  threadOf,
  verdictFor,
  verdictReason,
} from "./resolve";
import type { Message } from "./issues";

describe("verdictFor", () => {
  const s = RESOLVE_DEFAULTS;
  it("closes at closeMin, suggests from suggestMin, and leaves the rest open", () => {
    expect(verdictFor(0.85, s)).toBe("close");
    expect(verdictFor(0.84, s)).toBe("suggest");
    expect(verdictFor(0.6, s)).toBe("suggest");
    expect(verdictFor(0.59, s)).toBe("open");
  });
  it("is open when Jev was not asked or the check is off", () => {
    expect(verdictFor(null, s)).toBe("open");
    expect(verdictFor(0.99, { ...s, enabled: false })).toBe("open");
  });
});

describe("idleCloseAt", () => {
  const t0 = new Date("2026-10-01T00:00:00Z");
  const msg = (direction: string, hours: number) => ({
    direction,
    createdAt: new Date(t0.getTime() + hours * 3600_000),
  });
  it("counts from the newest customer or team message, only On Customer", () => {
    const issue = { status: "on_customer", createdAt: t0 };
    expect(
      idleCloseAt(
        issue,
        [msg("customer", 1), msg("agent", 5), msg("internal", 9)],
        48,
      ),
    ).toEqual(new Date(t0.getTime() + 53 * 3600_000));
    expect(idleCloseAt({ ...issue, status: "on_you" }, [], 48)).toBeNull();
    expect(idleCloseAt(issue, [], null)).toBeNull();
    expect(idleCloseAt(issue, [], 2)).toEqual(
      new Date(t0.getTime() + 2 * 3600_000),
    );
  });
  it("says days for whole days", () => {
    expect(idleReason(48)).toMatch(/^no reply from the customer in 2 days\./);
    expect(idleReason(24)).toMatch(/in 1 day\./);
    expect(idleReason(36)).toMatch(/in 36 hours\./);
  });
});

describe("threadOf", () => {
  it("keeps customer and team lines in order, drops internal notes and empty text", () => {
    const m = (direction: Message["direction"], text: string | null) =>
      ({ direction, text }) as Message;
    expect(
      threadOf([
        m("customer", "<@U1|Ilan> it broke"),
        m("internal", "looking"),
        m("agent", "fixed"),
        m("customer", "  "),
      ]),
    ).toEqual([
      { from: "customer", text: "@Ilan it broke" },
      { from: "support team", text: "fixed" },
    ]);
  });
});

describe("verdictReason", () => {
  it("quotes the customer's words, cut short, as plain text", () => {
    expect(verdictReason(0.913, "<@U1|Ilan> thanks!\n works now")).toBe(
      "Jev judged it resolved (91%). The customer said: “@Ilan thanks! works now”",
    );
  });
});
