import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { memoryDb, splitStatements, type Db } from "../db";
import { MIGRATIONS } from "./index";

const DIR = path.dirname(fileURLToPath(import.meta.url));

describe("migrations", () => {
  it("mirrors every .sql file byte for byte", () => {
    for (const m of MIGRATIONS) {
      expect(m.sql).toBe(readFileSync(path.join(DIR, `${m.id}.sql`), "utf8"));
    }
  });
});

describe("080_desks backfill", () => {
  const desksSql = MIGRATIONS.find((m) => m.id === "080_desks")!.sql;

  async function stage() {
    const db = await memoryDb({ through: "070_knowledge" });
    const [account] = await db.query<{ id: string }>(
      "insert into accounts (name, slack_channel_id) values ('Acme', 'C0ACME') returning id",
    );
    await db.query(
      "insert into issues (account_id, source, customer_channel, customer_root_ts) values ($1, 'slack', 'C0ACME', '1.1')",
      [account.id],
    );
    await db.query(
      "insert into kb_articles (kind, title, body) values ('policy', 'Tone', 'Be brief')",
    );
    return db;
  }
  const migrateDesks = async (db: Db) => {
    for (const stmt of splitStatements(desksSql)) await db.query(stmt);
  };
  const setConfigRow = (db: Db, key: string, value: unknown) =>
    db.query("insert into config (key, value) values ($1, $2::text::jsonb)", [
      key,
      JSON.stringify(value),
    ]);

  it("turns the live config into the default desk `test` and assigns existing rows to it", async () => {
    const db = await stage();
    await setConfigRow(db, "channels.triage", "C0TRIAGE");
    await setConfigRow(db, "linear.team_id", "team-1");
    await setConfigRow(db, "linear.project_id", "proj-1");
    await setConfigRow(db, "oncall.slack_id", "U0ONCALL");
    await setConfigRow(db, "nudge.minutes", 5);
    await migrateDesks(db);

    const desks = await db.query("select * from desks");
    expect(desks).toHaveLength(1);
    expect(desks[0]).toMatchObject({
      slug: "test",
      name: "Test",
      triage_channel: "C0TRIAGE",
      linear_team_id: "team-1",
      linear_project_id: "proj-1",
      oncall_slack_id: "U0ONCALL",
      nudge_minutes: 5,
      is_default: true,
    });
    const id = desks[0].id;
    expect(
      await db.query("select 1 from accounts where desk_id = $1", [id]),
    ).toHaveLength(1);
    expect(
      await db.query("select 1 from issues where desk_id = $1", [id]),
    ).toHaveLength(1);
    expect(
      await db.query("select 1 from kb_articles where desk_id is null"),
    ).toHaveLength(1);
  });

  it("inserts no desk on a database without config rows", async () => {
    const db = await stage();
    await migrateDesks(db);
    expect(await db.query("select 1 from desks")).toHaveLength(0);
    expect(
      await db.query("select 1 from accounts where desk_id is null"),
    ).toHaveLength(1);
  });

  it("allows at most one default desk", async () => {
    const db = await memoryDb();
    const insert = (slug: string) =>
      db.query(
        "insert into desks (slug, name, triage_channel, is_default) values ($1, $1, 'C0', true)",
        [slug],
      );
    await insert("a");
    await expect(insert("b")).rejects.toThrow();
  });
});

describe("081_desk_triage_unique", () => {
  it("rejects a second desk on the same triage channel", async () => {
    const db = await memoryDb();
    const insert = (slug: string, channel: string) =>
      db.query(
        "insert into desks (slug, name, triage_channel) values ($1, $1, $2)",
        [slug, channel],
      );
    await insert("a", "C0X");
    await insert("b", "C0Y");
    await expect(insert("c", "C0X")).rejects.toThrow();
  });
});

describe("101_draft_summary", () => {
  it("keeps an existing draft and gives it a null summary", async () => {
    const db = await memoryDb({ through: "100_linear_state" });
    const [account] = await db.query<{ id: string }>(
      "insert into accounts (name, slack_channel_id) values ('Acme', 'C0ACME') returning id",
    );
    const [issue] = await db.query<{ id: string }>(
      "insert into issues (account_id, source, customer_channel, customer_root_ts) values ($1, 'slack', 'C0ACME', '1.1') returning id",
      [account.id],
    );
    await db.query(
      "insert into drafts (issue_id, text, causation_id, confidence, status) values ($1, 'Hello', 'Ev1', 0.5, 'pending')",
      [issue.id],
    );
    const sql = MIGRATIONS.find((m) => m.id === "101_draft_summary")!.sql;
    for (const stmt of splitStatements(sql)) await db.query(stmt);

    const [draft] = await db.query("select * from drafts");
    expect(draft).toMatchObject({
      issue_id: issue.id,
      text: "Hello",
      causation_id: "Ev1",
      status: "pending",
      summary: null,
    });
  });
});
