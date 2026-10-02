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

  it("records the applied migrations", async () => {
    const db = await memoryDb();
    expect(
      await db.query("select id from schema_migrations order by id"),
    ).toEqual([
      { id: "001_init" },
      { id: "020_copilot" },
      { id: "050_linear_url" },
      { id: "070_knowledge" },
    ]);
  });

  it("keeps a standalone write made during a transaction that rolls back", async () => {
    const db = await memoryDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tx = db.transaction(async (t) => {
      await t.query(
        "insert into accounts (name, slack_channel_id) values ('in-tx', 'C1')",
      );
      await gate;
      throw new Error("rollback");
    });
    const standalone = db.query(
      "insert into accounts (name, slack_channel_id) values ('outside', 'C2')",
    );
    release();
    await expect(tx).rejects.toThrow("rollback");
    await standalone;
    expect(await db.query("select name from accounts")).toEqual([
      { name: "outside" },
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
