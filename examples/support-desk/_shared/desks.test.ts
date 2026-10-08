import { describe, expect, it } from "vitest";

import { setConfig } from "./config";
import { memoryDb } from "./db";
import {
  defaultDesk,
  deskBySlug,
  deskByTriageChannel,
  deskForIssue,
  getDesk,
  linearTarget,
  listDesks,
  NoDeskError,
  oncallFor,
  requireDefaultDesk,
  upsertDesk,
} from "./desks";

describe("desks", () => {
  it("creates, reads by id, slug and triage channel, and lists the default first", async () => {
    const db = await memoryDb();
    const test = await upsertDesk(db, {
      slug: "test",
      name: "Test",
      triageChannel: "C0TEST",
    });
    expect(test).toMatchObject({ created: true, updated: false });
    expect(test.desk.nudgeMinutes).toBe(30);
    const support = (
      await upsertDesk(db, {
        slug: "support",
        name: "Support",
        triageChannel: "C0SUPPORT",
        linearTeamId: "team",
        linearProjectId: "proj",
        oncallSlackId: "U1",
        nudgeMinutes: 10,
        isDefault: true,
      })
    ).desk;

    expect((await listDesks(db)).map((d) => d.slug)).toEqual([
      "support",
      "test",
    ]);
    expect(await getDesk(db, support.id)).toMatchObject({ slug: "support" });
    expect((await deskBySlug(db, "test"))?.id).toBe(test.desk.id);
    expect((await deskByTriageChannel(db, "C0SUPPORT"))?.slug).toBe("support");
    expect(await deskByTriageChannel(db, "C0OTHER")).toBeNull();
    expect(await deskBySlug(db, "nope")).toBeNull();
    expect((await defaultDesk(db))?.slug).toBe("support");
    await expect(
      getDesk(db, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow(/not found/);
  });

  it("has no default on an empty database, and requireDefaultDesk says so", async () => {
    const db = await memoryDb();
    expect(await defaultDesk(db)).toBeNull();
    await expect(requireDefaultDesk(db)).rejects.toBeInstanceOf(NoDeskError);
  });

  it("keeps an existing desk unless told to overwrite", async () => {
    const db = await memoryDb();
    await upsertDesk(db, { slug: "a", name: "A", triageChannel: "C0A" });
    const kept = await upsertDesk(db, {
      slug: "a",
      name: "Renamed",
      triageChannel: "C0NEW",
    });
    expect(kept).toMatchObject({ created: false, updated: false });
    expect(kept.desk).toMatchObject({ name: "A", triageChannel: "C0A" });
    const updated = await upsertDesk(
      db,
      { slug: "a", name: "Renamed", triageChannel: "C0NEW", nudgeMinutes: 7 },
      { overwrite: true },
    );
    expect(updated).toMatchObject({ created: false, updated: true });
    expect(updated.desk).toMatchObject({
      name: "Renamed",
      triageChannel: "C0NEW",
      nudgeMinutes: 7,
    });
  });

  it("moves the default flag to the newly marked desk", async () => {
    const db = await memoryDb();
    await upsertDesk(db, {
      slug: "a",
      name: "A",
      triageChannel: "C0A",
      isDefault: true,
    });
    await upsertDesk(db, {
      slug: "b",
      name: "B",
      triageChannel: "C0B",
      isDefault: true,
    });
    expect((await defaultDesk(db))?.slug).toBe("b");
    expect((await listDesks(db)).filter((d) => d.isDefault)).toHaveLength(1);
  });

  it("falls back to the pre-desk config for Linear and on-call only when the desk has none", async () => {
    const db = await memoryDb();
    const bare = (
      await upsertDesk(db, { slug: "bare", name: "Bare", triageChannel: "C0B" })
    ).desk;
    expect(await linearTarget(db, bare)).toBeNull();
    expect(await oncallFor(db, bare)).toBeNull();
    await setConfig(db, "linear.team_id", "gteam", "t");
    await setConfig(db, "linear.project_id", "gproj", "t");
    await setConfig(db, "oncall.slack_id", "UG", "t");
    expect(await linearTarget(db, bare)).toEqual({
      teamId: "gteam",
      projectId: "gproj",
    });
    expect(await oncallFor(db, bare)).toBe("UG");
    const own = (
      await upsertDesk(db, {
        slug: "own",
        name: "Own",
        triageChannel: "C0O",
        linearTeamId: "t",
        linearProjectId: "p",
        oncallSlackId: "U9",
      })
    ).desk;
    expect(await linearTarget(db, own)).toEqual({
      teamId: "t",
      projectId: "p",
    });
    expect(await oncallFor(db, own)).toBe("U9");
  });

  it("resolves an issue's desk, using the default for an issue without one", async () => {
    const db = await memoryDb();
    const a = (
      await upsertDesk(db, {
        slug: "a",
        name: "A",
        triageChannel: "C0A",
        isDefault: true,
      })
    ).desk;
    const b = (
      await upsertDesk(db, { slug: "b", name: "B", triageChannel: "C0B" })
    ).desk;
    expect((await deskForIssue(db, { deskId: b.id })).slug).toBe("b");
    expect((await deskForIssue(db, { deskId: null })).id).toBe(a.id);
  });
});
