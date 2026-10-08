import { describe, expect, it } from "vitest";

import {
  ConfigSchemas,
  MissingConfigError,
  OPTIONAL_KEYS,
  customerChannel,
  deskEscalation,
  getConfig,
  getConfigOr,
  setConfig,
  setDeskEscalation,
} from "./config";
import { memoryDb } from "./db";
import { seedFleet } from "./seed";
import { EXAMPLE_SLA } from "./test-ctx";

describe("config", () => {
  it("getConfigOr returns the fallback only when the key is unset", async () => {
    const db = await memoryDb();
    expect(await getConfigOr(db, "alerts.channel", null)).toBeNull();
    await setConfig(db, "alerts.channel", "C0ALERTS01", "test");
    expect(await getConfigOr(db, "alerts.channel", null)).toBe("C0ALERTS01");
  });

  it("throws a setup hint for a missing key", async () => {
    const db = await memoryDb();
    await expect(getConfig(db, "channels.triage")).rejects.toBeInstanceOf(
      MissingConfigError,
    );
    await expect(getConfig(db, "channels.triage")).rejects.toThrow(
      /pnpm run setup/,
    );
  });

  it("getConfigOr falls back for a missing key and returns a stored one", async () => {
    const db = await memoryDb();
    expect(await getConfigOr(db, "linear_sync.notify_customer", false)).toBe(
      false,
    );
    await setConfig(db, "linear_sync.notify_customer", true, "test");
    expect(await getConfigOr(db, "linear_sync.notify_customer", false)).toBe(
      true,
    );
  });

  it("getConfigOr returns the fallback for an unset key and the value once set", async () => {
    const db = await memoryDb();
    expect(await getConfigOr(db, "intake.reactions", true)).toBe(true);
    await setConfig(db, "intake.reactions", false, "test");
    expect(await getConfigOr(db, "intake.reactions", true)).toBe(false);
  });

  it("customerChannel finds nothing, rather than throwing, when channels.customer is unset", async () => {
    const db = await memoryDb();
    expect(await customerChannel(db, "C1")).toBeNull();
  });

  it("round-trips typed values and overwrites on a second set", async () => {
    const db = await memoryDb();
    await setConfig(db, "nudge.minutes", 5, "test");
    await setConfig(db, "nudge.minutes", 2, "test");
    await setConfig(
      db,
      "channels.customer",
      [{ channelId: "C1", accountName: "Acme" }],
      "test",
    );
    expect(await getConfig(db, "nudge.minutes")).toBe(2);
    expect(await customerChannel(db, "C1")).toEqual({
      channelId: "C1",
      accountName: "Acme",
    });
    expect(await customerChannel(db, "C2")).toBeNull();
    const [row] = await db.query<{ value: unknown; set_by: string }>(
      "select value, set_by from config where key = 'nudge.minutes'",
    );
    expect(row).toEqual({ value: 2, set_by: "test" });
  });

  it("does not serve a value from a rolled-back write", async () => {
    const db = await memoryDb();
    await setConfig(db, "nudge.minutes", 5, "test");
    expect(await getConfig(db, "nudge.minutes")).toBe(5);
    await expect(
      db.transaction(async (tx) => {
        await setConfig(tx, "nudge.minutes", 9, "test");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await getConfig(db, "nudge.minutes")).toBe(5);
  });

  it("rejects a value of the wrong shape", async () => {
    const db = await memoryDb();
    await expect(setConfig(db, "nudge.minutes", -1, "test")).rejects.toThrow();
  });

  describe("escalation", () => {
    const levelsOk = (levels: unknown) =>
      ConfigSchemas.escalation.safeParse({ support: { levels } }).success;

    it("accepts 1 to 5 strictly ascending positive integer levels only", () => {
      expect(levelsOk([30])).toBe(true);
      expect(levelsOk([5, 30, 60, 120, 240])).toBe(true);
      expect(levelsOk([])).toBe(false);
      expect(levelsOk([30, 30])).toBe(false);
      expect(levelsOk([60, 30])).toBe(false);
      expect(levelsOk([1.5])).toBe(false);
      expect(levelsOk([0])).toBe(false);
      expect(levelsOk([1, 2, 3, 4, 5, 6])).toBe(false);
    });

    it("sets a desk entry when the key did not exist, and reads it back", async () => {
      const db = await memoryDb();
      expect(await deskEscalation(db, "support")).toBeNull();
      const entry = { levels: [30, 120], groupId: "S0SUPPORT1" };
      await setDeskEscalation(db, "support", entry, "console");
      expect(await deskEscalation(db, "support")).toEqual(entry);
      const [row] = await db.query<{ set_by: string }>(
        "select set_by from config where key = 'escalation'",
      );
      expect(row.set_by).toBe("console");
    });

    it("turning one desk off keeps the other; the last one off leaves {}", async () => {
      const db = await memoryDb();
      await setDeskEscalation(db, "support", { levels: [30] }, "test");
      await setDeskEscalation(db, "vip", { levels: [5] }, "test");
      await setDeskEscalation(db, "support", null, "test");
      expect(await deskEscalation(db, "support")).toBeNull();
      expect(await deskEscalation(db, "vip")).toEqual({ levels: [5] });
      await setDeskEscalation(db, "vip", null, "test");
      expect(await getConfig(db, "escalation")).toEqual({});
    });

    it("two concurrent saves for different desks both survive", async () => {
      const db = await memoryDb();
      await Promise.all([
        setDeskEscalation(db, "support", { levels: [30] }, "test"),
        setDeskEscalation(db, "vip", { levels: [5] }, "test"),
      ]);
      expect(await getConfig(db, "escalation")).toEqual({
        support: { levels: [30] },
        vip: { levels: [5] },
      });
    });

    it("reads a change written through another handle", async () => {
      const db = await memoryDb();
      await setDeskEscalation(db, "support", { levels: [5] }, "test");
      expect(await deskEscalation(db, "support")).toEqual({ levels: [5] });
      // The Console writes from its own process, so this handle's cache never sees it.
      await db.query(
        "update config set value = '{}'::jsonb where key = 'escalation'",
      );
      expect(await deskEscalation(db, "support")).toBeNull();
    });

    it("rejects an invalid entry without writing", async () => {
      const db = await memoryDb();
      await expect(
        setDeskEscalation(db, "support", { levels: [60, 30] }, "test"),
      ).rejects.toThrow();
      expect(await getConfigOr(db, "escalation", null)).toBeNull();
    });
  });

  it("nudge.repeat_minutes takes positive whole minutes, and setup leaves it unset by default", async () => {
    const db = await memoryDb();
    await seedFleet(db, "test");
    expect(await getConfigOr(db, "nudge.repeat_minutes", null)).toBeNull();
    for (const ok of [[], [60, 240]]) {
      await setConfig(db, "nudge.repeat_minutes", ok, "test");
      expect(await getConfig(db, "nudge.repeat_minutes")).toEqual(ok);
    }
    for (const bad of [[0], [-5], [1.5]])
      await expect(
        setConfig(db, "nudge.repeat_minutes", bad, "test"),
      ).rejects.toThrow();
  });

  it("stores an sla, which fleet.json may omit", async () => {
    expect(OPTIONAL_KEYS).toContain("sla");
    const db = await memoryDb();
    expect(await getConfigOr(db, "sla", null)).toBeNull();
    await setConfig(db, "sla", EXAMPLE_SLA, "test");
    expect(await getConfig(db, "sla")).toEqual(EXAMPLE_SLA);
    await expect(
      setConfig(
        db,
        "sla",
        {
          ...EXAMPLE_SLA,
          businessHours: {
            ...EXAMPLE_SLA.businessHours,
            timeZone: "Nowhere/City",
          },
        },
        "test",
      ),
    ).rejects.toThrow(/timeZone/);
  });
});
