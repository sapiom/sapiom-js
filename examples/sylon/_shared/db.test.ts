import { describe, expect, it } from "vitest";

import { memoryDb, resolveConnectionString } from "./db";

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

describe("resolveConnectionString", () => {
  const conn = { connection: { connectionString: "postgresql://x" } };
  const ctxWith = (
    get: () => Promise<unknown>,
    create: () => Promise<unknown>,
  ) => ({ sapiom: { database: { get, create } } }) as never;

  it("creates the database only when the handle is missing (404)", async () => {
    let created = 0;
    const missing = Object.assign(new Error("not found"), { status: 404 });
    await expect(
      resolveConnectionString(
        ctxWith(
          () => Promise.reject(missing),
          async () => (created++, conn),
        ),
      ),
    ).resolves.toBe("postgresql://x");
    expect(created).toBe(1);
  });

  it("surfaces any other failure without provisioning", async () => {
    let created = 0;
    const outage = Object.assign(new Error("bad gateway"), { status: 502 });
    await expect(
      resolveConnectionString(
        ctxWith(
          () => Promise.reject(outage),
          async () => (created++, conn),
        ),
      ),
    ).rejects.toThrow("bad gateway");
    expect(created).toBe(0);
  });
});
