import { describe, expect, it } from "vitest";

import {
  MissingConfigError,
  customerChannel,
  getConfig,
  getConfigOr,
  setConfig,
} from "./config";
import { memoryDb } from "./db";

describe("config", () => {
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
});
