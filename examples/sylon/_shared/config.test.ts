import { describe, expect, it } from "vitest";

import {
  MissingConfigError,
  customerChannel,
  getConfig,
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

  it("rejects a value of the wrong shape", async () => {
    const db = await memoryDb();
    await expect(setConfig(db, "nudge.minutes", -1, "test")).rejects.toThrow();
  });
});
