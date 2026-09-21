/**
 * A Sapiom Postgres is permanent (SAP-3100): `database.create({})` is the whole
 * call. The stub has to accept that shape, so an agent written against the
 * served authoring rules runs under `run_local` exactly as it deploys, and it
 * must not invent a lifetime the real gateway no longer returns.
 */
import { createStubClient } from "./index.js";

describe("stub database is permanent", () => {
  it("accepts database.create({}) with no duration", async () => {
    const db = await createStubClient({}).database.create({});

    expect(db.id).toBe("stub-db");
    expect(db.status).toBe("active");
    expect(db.connection?.connectionString).toMatch(/^postgresql:\/\//);
  });

  it("accepts database.create() with no argument at all", async () => {
    const db = await createStubClient({}).database.create();

    expect(db.id).toBe("stub-db");
    expect(db.connection?.connectionString).toMatch(/^postgresql:\/\//);
  });

  it("synthesizes no expiresAt and no duration for a new database", async () => {
    const client = createStubClient({});
    const created = await client.database.create({ handle: "analytics" });
    const got = await client.database.get("analytics");

    for (const db of [created, got]) {
      expect(db.expiresAt ?? null).toBeNull();
      expect(db.duration).toBeUndefined();
    }
  });

  it("still accepts a legacy duration without changing the result", async () => {
    const client = createStubClient({});
    const db = await client.database.create({ duration: "7d", handle: "old" });

    expect(db.handle).toBe("old");
    expect(db.expiresAt ?? null).toBeNull();
  });
});
