import { describe, expect, it } from "vitest";

import { memoryDb } from "./db";

describe("db", () => {
  it("creates every M1 table", async () => {
    const db = await memoryDb();
    for (const table of [
      "accounts",
      "issues",
      "messages",
      "drafts",
      "nudges",
      "runs",
      "events_log",
      "config",
    ]) {
      await expect(
        db.query(`select count(*) from ${table}`),
      ).resolves.toHaveLength(1);
    }
  });

  it("records the applied migration", async () => {
    const db = await memoryDb();
    expect(await db.query("select id from schema_migrations")).toEqual([
      { id: "001_init" },
    ]);
  });

  it("rolls a transaction back on throw", async () => {
    const db = await memoryDb();
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          "insert into accounts (name, slack_channel_id) values ('a', 'C1')",
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query("select * from accounts")).toEqual([]);
  });
});
