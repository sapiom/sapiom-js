/** The Settings tab's reads and writes on pg-mem: validated, scoped to the desk, read by the agents. */
import { beforeEach, describe, expect, it } from "vitest";

import { getConfigOr, setConfig } from "../../_shared/config";
import { memoryDb, type Db } from "../../_shared/db";
import { deskBySlug, upsertDesk, type Desk } from "../../_shared/desks";
import {
  digestSchedule,
  getSettings,
  putDeskSettings,
  putFleetSettings,
} from "./settings";

let db: Db;
let test: Desk;
let support: Desk;

beforeEach(async () => {
  db = await memoryDb();
  test = (
    await upsertDesk(db, {
      slug: "test",
      name: "Test",
      triageChannel: "C0TESTTRI",
      isDefault: true,
    })
  ).desk;
  support = (
    await upsertDesk(db, {
      slug: "support",
      name: "Support",
      triageChannel: "C0SUPTRI",
      nudgeMinutes: 5,
    })
  ).desk;
});

describe("desk settings", () => {
  it("updates only the fields sent, on the selected desk", async () => {
    const res = await putDeskSettings(db, support, {
      oncallSlackId: "U0ONCALL2",
      nudgeMinutes: 15,
    });
    expect(res.status).toBe(200);
    expect(await deskBySlug(db, "support")).toMatchObject({
      name: "Support",
      triageChannel: "C0SUPTRI",
      oncallSlackId: "U0ONCALL2",
      nudgeMinutes: 15,
      isDefault: false,
    });
    expect(await deskBySlug(db, "test")).toMatchObject({
      oncallSlackId: null,
      nudgeMinutes: 30,
    });
  });

  it("clears a nullable field with null", async () => {
    await putDeskSettings(db, support, { linearProjectId: "proj-1" });
    const set = (await deskBySlug(db, "support"))!;
    await putDeskSettings(db, set, { linearProjectId: null });
    expect((await deskBySlug(db, "support"))?.linearProjectId).toBeNull();
  });

  it("moves the default to the desk, and never unsets it", async () => {
    await putDeskSettings(db, support, { isDefault: true });
    expect((await deskBySlug(db, "support"))?.isDefault).toBe(true);
    expect((await deskBySlug(db, "test"))?.isDefault).toBe(false);
    expect((await putDeskSettings(db, test, { isDefault: false })).status).toBe(
      400,
    );
  });

  it("rejects bad ids, unknown fields, and another desk's triage channel", async () => {
    const bad = async (body: unknown) =>
      (await putDeskSettings(db, support, body)) as {
        status: number;
        body: { error: string };
      };
    expect((await bad({ triageChannel: "general" })).body.error).toMatch(
      /triageChannel/,
    );
    expect((await bad({ oncallSlackId: "dave" })).status).toBe(400);
    expect((await bad({ nudgeMinutes: 0 })).status).toBe(400);
    expect((await bad({ slug: "renamed" })).status).toBe(400);
    expect((await bad({ triageChannel: "C0TESTTRI" })).status).toBe(409);
    expect((await deskBySlug(db, "support"))?.triageChannel).toBe("C0SUPTRI");
  });
});

describe("fleet settings", () => {
  it("writes the keys the agents read, and null restores the default", async () => {
    const res = await putFleetSettings(db, support, {
      "nudge.repeat_minutes": [30, 120],
      "digest.sla_hours": { urgent: 2 },
      "linear_sync.notify_customer": true,
    });
    expect(res.status).toBe(200);
    expect(await getConfigOr(db, "nudge.repeat_minutes", null)).toEqual([
      30, 120,
    ]);
    expect(await getConfigOr(db, "digest.sla_hours", null)).toEqual({
      urgent: 2,
    });
    expect(await getConfigOr(db, "linear_sync.notify_customer", null)).toBe(
      true,
    );
    await putFleetSettings(db, support, {
      "nudge.repeat_minutes": null,
      "digest.sla_hours": null,
    });
    expect(await getConfigOr(db, "nudge.repeat_minutes", null)).toBeNull();
    expect(await getConfigOr(db, "digest.sla_hours", null)).toBeNull();
  });

  it("validates with the config schemas", async () => {
    await setConfig(db, "linear_sync.notify_customer", false, "test");
    for (const body of [
      { "nudge.repeat_minutes": [0] },
      { "digest.sla_hours": { urgent: -1 } },
      { "digest.sla_hours": { critical: 1 } },
      { "linear_sync.notify_customer": "yes" },
      { "intake.reactions": false },
    ])
      expect((await putFleetSettings(db, support, body)).status).toBe(400);
    expect(await getConfigOr(db, "linear_sync.notify_customer", null)).toBe(
      false,
    );
  });

  it("reads back the desk, the keys with their defaults, and the digest schedule", async () => {
    const { body } = (await getSettings(db, support)) as {
      body: Record<string, Record<string, unknown>>;
    };
    expect(body.desk).toMatchObject({ slug: "support", nudgeMinutes: 5 });
    expect(body.fleet).toEqual({
      "nudge.repeat_minutes": null,
      "digest.sla_hours": null,
      "linear_sync.notify_customer": false,
    });
    expect(body.defaults["nudge.repeat_minutes"]).toEqual([60, 240]);
    expect(body.digest).toEqual(digestSchedule());
    expect(digestSchedule()).toEqual({
      cron: "0 9 * * *",
      timezone: "America/Los_Angeles",
    });
  });
});
