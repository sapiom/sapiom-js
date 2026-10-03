import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getConfig, getConfigOr, setConfig } from "./_shared/config";
import { memoryDb } from "./_shared/db";
import { Events, SlackEvents } from "./_shared/events";
import { accountByChannel } from "./_shared/issues";
import { defaultDesk, deskBySlug, upsertDesk } from "./_shared/desks";
import { exampleKeys, mergeConfig, mergeDesks, seedFleet } from "./_shared/seed";
import fleet from "./fleet.json";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const keys = new Set(fleet.projects.map((p) => p.key));

describe("fleet.json", () => {
  it("lists every M1 project", () => {
    for (const k of [
      "intake",
      "copilot",
      "escalation",
      "controller",
      "urgent-pager",
      "watchdog",
    ])
      expect(keys).toContain(k);
  });

  it("points every trigger at a listed project and a known event type", () => {
    const known = new Set([
      ...Object.keys(Events),
      ...Object.keys(SlackEvents),
    ]);
    for (const t of [...fleet.triggers, ...fleet.smokeTriggers]) {
      expect(keys).toContain(t.project);
      if (t.kind === "event") expect(known).toContain(t.eventType);
      else expect(t.kind).toBe("schedule_cron");
    }
  });

  it("has an index.ts and a package.json for every project", () => {
    for (const p of fleet.projects) {
      expect(existsSync(path.join(DIR, p.path, "package.json"))).toBe(true);
      expect(existsSync(path.join(DIR, p.path, "index.ts"))).toBe(true);
    }
  });

  it("seeds desks, config and accounts, twice without change", async () => {
    const db = await memoryDb();
    await seedFleet(db, "test");
    const second = await seedFleet(db, "test");
    expect(second).toMatchObject({ desksSet: [], desksKept: ["support"] });
    const desk = await deskBySlug(db, "support");
    expect(desk).toMatchObject({
      triageChannel: "C0TRIAGE001",
      linearTeamId: "example-linear-team-id",
      nudgeMinutes: 5,
      isDefault: true,
    });
    const account = await accountByChannel(db, "C0CUSTOMER1");
    expect(account?.name).toBe("Example Customer");
    expect(account?.deskId).toBe(desk?.id);
    expect(await db.query("select * from accounts")).toHaveLength(1);
    expect(await db.query("select * from desks")).toHaveLength(1);
  });

  it("seeds several desks, files a channel under its desk, and rejects an unknown desk slug", async () => {
    const db = await memoryDb();
    const desks = [
      { slug: "test", name: "Test", triageChannel: "C0TESTTRI", default: true },
      { slug: "support", name: "Support", triageChannel: "C0SUPPTRI" },
    ];
    const values = {
      ...mergeConfig(undefined),
      "channels.customer": [
        { channelId: "C0A", accountName: "Acme", desk: "support" },
        { channelId: "C0B", accountName: "Bolt" },
      ],
    };
    await seedFleet(db, "setup", { values, desks });
    const support = await deskBySlug(db, "support");
    expect((await accountByChannel(db, "C0A"))?.deskId).toBe(support?.id);
    expect((await accountByChannel(db, "C0B"))?.deskId).toBe(
      (await defaultDesk(db))?.id,
    );
    expect((await defaultDesk(db))?.slug).toBe("test");

    const bad = {
      ...values,
      "channels.customer": [
        { channelId: "C0C", accountName: "Cy", desk: "nope" },
      ],
    };
    await expect(
      seedFleet(await memoryDb(), "setup", { values: bad, desks }),
    ).rejects.toThrow(/desk 'nope'/);
  });

  it("makes the first desk the default when the file marks none", async () => {
    const db = await memoryDb();
    await seedFleet(db, "setup", {
      desks: [
        { slug: "a", name: "A", triageChannel: "C0A" },
        { slug: "b", name: "B", triageChannel: "C0B" },
      ],
    });
    expect((await defaultDesk(db))?.slug).toBe("a");
  });

  it("keeps an onboarded desk on a rerun unless told to overwrite", async () => {
    const db = await memoryDb();
    await seedFleet(db, "setup");
    const desk = (await deskBySlug(db, "support"))!;
    await upsertDesk(
      db,
      { slug: "support", name: "Support", triageChannel: "C0TRIAGE001", nudgeMinutes: 30, isDefault: true },
      { overwrite: true },
    );
    expect(await seedFleet(db, "setup")).toMatchObject({ desksSet: [] });
    expect((await deskBySlug(db, "support"))?.nudgeMinutes).toBe(30);
    await seedFleet(db, "setup", { overwrite: true });
    expect((await deskBySlug(db, "support"))?.nudgeMinutes).toBe(5);
    expect((await deskBySlug(db, "support"))?.id).toBe(desk.id);
  });

  it("does not require the desk-owned config keys", async () => {
    const db = await memoryDb();
    await seedFleet(db, "setup");
    expect(await getConfigOr(db, "channels.triage", null)).toBeNull();
    expect(await getConfigOr(db, "nudge.minutes", null)).toBeNull();
  });

  it("removes an optional key the file omits on overwrite so readers fall back", async () => {
    const db = await memoryDb();
    await seedFleet(db, "setup");
    await setConfig(db, "alerts.channel", "C0ALERTS01", "onboarding");
    const values = { ...mergeConfig(undefined) } as Record<string, unknown>;
    delete values["alerts.channel"];
    // Without overwrite the onboarded value stays.
    await seedFleet(db, "setup", { values: values as never });
    expect(await getConfigOr(db, "alerts.channel", null)).toBe("C0ALERTS01");
    const out = await seedFleet(db, "setup", {
      overwrite: true,
      values: values as never,
    });
    expect(out.removed).toEqual(["alerts.channel"]);
    expect(await getConfigOr(db, "alerts.channel", null)).toBeNull();
  });

  it("flags every value left at its example, and none once overridden", () => {
    const flagged = exampleKeys(mergeConfig(undefined), mergeDesks(undefined));
    expect(flagged).toEqual([
      "channels.customer",
      "desks.support.triageChannel",
      "desks.support.linearTeamId",
      "desks.support.linearProjectId",
      "desks.support.oncallSlackId",
    ]);
    const local = {
      "channels.customer": [{ channelId: "C2", accountName: "Acme" }],
    };
    const desks = [
      {
        slug: "support",
        name: "Support",
        triageChannel: "C1",
        linearTeamId: "t",
        linearProjectId: "p",
        oncallSlackId: "U1",
      },
    ];
    expect(exampleKeys(mergeConfig(local), desks)).toEqual([]);
    // A desk is flagged field by field.
    expect(
      exampleKeys(mergeConfig(local), [
        { ...desks[0], triageChannel: "C0TRIAGE001" },
      ]),
    ).toEqual(["desks.support.triageChannel"]);
    const examples = mergeConfig(undefined)["channels.customer"] as {
      channelId: string;
      accountName: string;
    }[];
    const mixed = mergeConfig({
      "channels.customer": [
        { channelId: "C2", accountName: "Acme" },
        ...examples,
      ],
    });
    expect(exampleKeys(mixed, desks)).toEqual(["channels.customer"]);
  });
});
