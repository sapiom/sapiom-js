import { beforeEach, describe, expect, it } from "vitest";

import { getConfig, setDeskEscalation } from "../../_shared/config";
import { localFleetDb, type Db } from "../../_shared/db";
import { defaultDesk, upsertDesk, type Desk } from "../../_shared/desks";
import { getEscalation, putEscalation } from "./escalation";

describe("console escalation", () => {
  let db: Db;
  let support: Desk;
  let vip: Desk;
  beforeEach(async () => {
    db = await localFleetDb();
    support = (await defaultDesk(db))!;
    vip = (
      await upsertDesk(db, {
        slug: "vip",
        name: "VIP",
        triageChannel: "C0VIPTRI01",
      })
    ).desk;
  });

  const row = async () =>
    (
      await db.query<{ value: unknown; set_by: string }>(
        "select value, set_by from config where key = 'escalation'",
      )
    )[0];

  it("GET returns the desk, its entry and the on-call fallback", async () => {
    expect(await getEscalation(db, support)).toEqual({
      status: 200,
      body: { desk: "support", entry: null, oncallFallback: "U0ONCALL001" },
    });
  });

  it("PUT rejects descending levels and leaves the config row unchanged", async () => {
    await setDeskEscalation(db, "vip", { levels: [5] }, "setup");
    const before = await row();
    const res = await putEscalation(db, support, { levels: [60, 30] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("levels"),
    });
    expect(await row()).toEqual(before);
  });

  it("PUT writes only the selected desk, as the console", async () => {
    await setDeskEscalation(db, "vip", { levels: [5] }, "setup");
    const res = await putEscalation(db, support, {
      levels: [30, 120],
      groupId: "S0SUPPORT1",
    });
    expect(res).toMatchObject({
      status: 200,
      body: { entry: { levels: [30, 120], groupId: "S0SUPPORT1" } },
    });
    expect(await getConfig(db, "escalation")).toEqual({
      support: { levels: [30, 120], groupId: "S0SUPPORT1" },
      vip: { levels: [5] },
    });
    expect((await row()).set_by).toBe("console");
  });

  it("PUT { off: true } removes only that desk", async () => {
    await putEscalation(db, support, { levels: [30] });
    await putEscalation(db, vip, { levels: [5] });
    const res = await putEscalation(db, support, { off: true });
    expect(res).toMatchObject({ status: 200, body: { entry: null } });
    expect(await getConfig(db, "escalation")).toEqual({ vip: { levels: [5] } });
  });
});
