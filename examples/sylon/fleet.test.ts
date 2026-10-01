import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getConfig, setConfig } from "./_shared/config";
import { memoryDb } from "./_shared/db";
import { Events, SlackEvents } from "./_shared/events";
import { accountByChannel } from "./_shared/issues";
import { exampleKeys, mergeConfig, seedFleet } from "./_shared/seed";
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

  it("has an index.ts for every smoke project", () => {
    for (const p of fleet.projects.filter((x) => "smoke" in x))
      expect(existsSync(path.join(DIR, p.path, "index.ts"))).toBe(true);
  });

  it("seeds config and accounts, twice without change", async () => {
    const db = await memoryDb();
    await seedFleet(db, "test");
    await seedFleet(db, "test");
    expect(await getConfig(db, "channels.triage")).toBe("C0TRIAGE001");
    expect(await getConfig(db, "linear.team_id")).toBe(
      "example-linear-team-id",
    );
    expect((await accountByChannel(db, "C0CUSTOMER1"))?.name).toBe(
      "Example Customer",
    );
    expect(await db.query("select * from accounts")).toHaveLength(1);
  });

  it("keeps onboarded config on a rerun unless told to overwrite", async () => {
    const db = await memoryDb();
    await seedFleet(db, "setup");
    await setConfig(db, "nudge.minutes", 30, "onboarding");
    expect(await seedFleet(db, "setup")).toMatchObject({ set: [] });
    expect(await getConfig(db, "nudge.minutes")).toBe(30);
    await seedFleet(db, "setup", { overwrite: true });
    expect(await getConfig(db, "nudge.minutes")).toBe(
      fleet.config["nudge.minutes"],
    );
  });

  it("flags every key left at its example value, and none once overridden", () => {
    expect(exampleKeys(mergeConfig(undefined))).toHaveLength(5);
    const local = {
      "linear.team_id": "t",
      "linear.project_id": "p",
      "channels.triage": "C1",
      "channels.customer": [{ channelId: "C2", accountName: "Acme" }],
      "oncall.slack_id": "U1",
    };
    expect(exampleKeys(mergeConfig(local))).toEqual([]);
    expect(exampleKeys(mergeConfig({ "channels.triage": "C1" }))).not.toContain(
      "channels.triage",
    );
    const examples = mergeConfig(undefined)["channels.customer"] as {
      channelId: string;
      accountName: string;
    }[];
    const mixed = mergeConfig({
      ...local,
      "channels.customer": [
        { channelId: "C2", accountName: "Acme" },
        ...examples,
      ],
    });
    expect(exampleKeys(mixed)).toEqual(["channels.customer"]);
  });
});
