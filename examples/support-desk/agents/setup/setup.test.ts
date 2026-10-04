/** setup: the pure rules, each step against pg-mem and stubbed connectors, then a local trace. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfigOr } from "../../_shared/config";
import { localFleetDb, memoryDb, setLocalDb, type Db } from "../../_shared/db";
import { STARTER_POLICIES } from "../../_shared/kb";
import { SlackMethodError } from "../../_shared/slack";
import { fakeCtx } from "../../_shared/test-ctx";
import { agent, prepareDatabase, probeLinear, probeSlack } from "./index";
import {
  SetupInput,
  channelCheck,
  configErrors,
  nextSteps,
  parseProjects,
  parseTeams,
} from "./logic";

const DESK = {
  slug: "support",
  name: "Support",
  triageChannel: "C0REALTRI1",
  oncallSlackId: "U0REALONC1",
  default: true,
};
const CONFIG = {
  "channels.customer": [{ channelId: "C0REALCUS1", accountName: "Acme" }],
};
const input = (raw: unknown) => SetupInput.parse(raw);

describe("logic", () => {
  const slackErr = (detail: string) =>
    new SlackMethodError("conversations.replies", 200, detail);

  it("reads thread_not_found as a readable channel", () => {
    expect(channelCheck("t", "C1", slackErr("thread_not_found"))).toMatchObject(
      { ok: true, detail: "readable" },
    );
    expect(channelCheck("t", "C1", null).ok).toBe(true);
  });

  it("says a channel without the bot fails silently, and how to invite it", () => {
    const c = channelCheck("t", "C1", slackErr("not_in_channel"));
    expect(c.ok).toBe(false);
    expect(c.fix).toMatch(/Invite the Sapiom Slack bot to C1/);
    expect(c.fix).toMatch(/fails silently/);
  });

  it.each([
    ["channel_not_found", /Check the id C1/],
    ["missing_scope", /Reconnect Slack/],
    ["invalid_auth", /Reconnect Slack/],
  ])("gives a fix for %s", (detail, fix) => {
    expect(channelCheck("t", "C1", slackErr(detail)).fix).toMatch(fix);
  });

  it("reads Linear teams and projects from the shapes the relay returns", () => {
    const teams = [{ id: "t1", name: "Core", key: "COR" }, { name: "no id" }];
    expect(parseTeams(teams)).toEqual([{ id: "t1", name: "Core", key: "COR" }]);
    expect(parseTeams({ teams })).toHaveLength(1);
    expect(
      parseTeams({ data: { nodes: [{ uuid: "t2", name: "X" }] } }),
    ).toEqual([{ id: "t2", name: "X" }]);
    expect(parseTeams(null)).toEqual([]);
    expect(
      parseProjects({
        projects: [
          { id: "p1", name: "Support", teams: [{ name: "Core" }] },
          { id: "p2", name: "Other", team: "Ops" },
        ],
      }),
    ).toEqual([
      { id: "p1", name: "Support", teams: ["Core"] },
      { id: "p2", name: "Other", teams: ["Ops"] },
    ]);
  });

  it("validates config keys and values against the fleet's schemas", () => {
    expect(configErrors({ "intake.reactions": true })).toEqual([]);
    expect(configErrors({ nope: 1 })).toEqual([
      "config 'nope' is not a config key",
    ]);
    expect(
      configErrors({ "knowledge.docs_url": "http://docs.example.com" })[0],
    ).toMatch(/https/);
  });

  it("rejects malformed desks before anything runs", () => {
    expect(() =>
      input({ desks: [{ ...DESK, triageChannel: "general" }] }),
    ).toThrow(/channel id/);
    expect(() => input({ desks: [{ ...DESK, extra: 1 }] })).toThrow();
    expect(input({})).toEqual({ overwrite: false });
  });

  it("lists next steps from the gaps", () => {
    const steps = nextSteps({
      desks: [],
      checks: [
        {
          target: "linear connector",
          ok: false,
          detail: "401",
          fix: "Connect Linear",
        },
      ],
      linear: null,
      docsUrl: null,
    });
    expect(steps[0]).toMatch(/seed your first desk/);
    expect(steps).toContain("linear connector: Connect Linear");
    expect(steps.at(-1)).toMatch(/knowledge.docs_url/);
    expect(
      nextSteps({
        desks: [{ slug: "support", linearTeamId: null }],
        checks: [],
        linear: { teams: [{ id: "t1", name: "Core" }] },
        docsUrl: "https://docs.example.com",
      }),
    ).toEqual([expect.stringMatching(/Linear team on support/)]);
  });
});

describe("prepareDatabase", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
  });

  it("only reports when the input seeds nothing", async () => {
    expect(await prepareDatabase(db, input({}))).toEqual({
      seeded: null,
      desks: [],
      customerChannels: 0,
      articles: 0,
      docsUrl: null,
    });
  });

  it("seeds desks, config, accounts and the starter articles, then keeps them on a rerun", async () => {
    const first = await prepareDatabase(
      db,
      input({
        desks: [DESK],
        config: { ...CONFIG, "knowledge.docs_url": "https://docs.example.com" },
      }),
    );
    expect(first.seeded).toMatchObject({
      desksSet: ["support"],
      starterArticles: STARTER_POLICIES.length,
    });
    expect(first).toMatchObject({
      desks: [
        { slug: "support", triageChannel: "C0REALTRI1", isDefault: true },
      ],
      customerChannels: 1,
      articles: STARTER_POLICIES.length,
      docsUrl: "https://docs.example.com",
    });
    const again = await prepareDatabase(
      db,
      input({ desks: [{ ...DESK, name: "Renamed" }], config: CONFIG }),
    );
    // Desks and unnamed keys are kept; a key named in the input is written again.
    expect(again.seeded).toMatchObject({
      desksSet: [],
      desksKept: ["support"],
      set: ["channels.customer"],
      starterArticles: 0,
    });
    expect(again.seeded?.kept).toContain("intake.reactions");
    expect(again.desks[0].name).toBe("Support");
  });

  it("overwrite resets desks and removes optional keys the input omits", async () => {
    await prepareDatabase(
      db,
      input({
        desks: [DESK],
        config: { ...CONFIG, "knowledge.docs_url": "https://docs.example.com" },
      }),
    );
    const out = await prepareDatabase(
      db,
      input({
        desks: [{ ...DESK, linearTeamId: "team-1" }],
        config: CONFIG,
        overwrite: true,
      }),
    );
    expect(out.desks[0].linearTeamId).toBe("team-1");
    expect(out.seeded?.removed).toContain("knowledge.docs_url");
    expect(await getConfigOr(db, "knowledge.docs_url", null)).toBeNull();
  });

  it("writes named config alone once a desk exists, and needs desks on the first run", async () => {
    await expect(
      prepareDatabase(db, input({ config: CONFIG })),
    ).rejects.toThrow(/no desk yet/);
    await prepareDatabase(db, input({ desks: [DESK], config: CONFIG }));
    const out = await prepareDatabase(
      db,
      input({
        config: { ...CONFIG, "customers.test_user_ids": ["U0TESTER01"] },
      }),
    );
    expect(out.seeded?.set).toContain("customers.test_user_ids");
  });

  it("a config-only rerun keeps the stored customer channels instead of fleet.json's example", async () => {
    await prepareDatabase(
      db,
      input({ desks: [DESK], config: { "channels.customer": [] } }),
    );
    const out = await prepareDatabase(
      db,
      input({ config: { "customers.test_user_ids": ["U0TESTER01"] } }),
    );
    expect(out.seeded?.set).toEqual(["customers.test_user_ids"]);
    expect(out.customerChannels).toBe(0);
    expect(await db.query("select * from accounts")).toEqual([]);
  });

  it("refuses fleet.json's example ids and bad config, writing nothing", async () => {
    await expect(
      prepareDatabase(
        db,
        input({
          desks: [{ ...DESK, triageChannel: "C0TRIAGE001" }],
          config: CONFIG,
        }),
      ),
    ).rejects.toThrow(/desks.support.triageChannel/);
    await expect(prepareDatabase(db, input({ desks: [DESK] }))).rejects.toThrow(
      /channels.customer.*"channels.customer": \[\]/,
    );
    await expect(
      prepareDatabase(db, input({ desks: [DESK], config: { nope: 1 } })),
    ).rejects.toThrow(/not a config key/);
    expect(await db.query("select * from desks")).toEqual([]);
  });
});

/** A context whose connectors are stubs: Slack by channel id, Linear by tool name. */
function connectorCtx(opts: {
  channels?: Record<string, string>;
  users?: Record<string, string>;
  linear?: Record<string, unknown> | Error;
}) {
  const fake = fakeCtx();
  const calls: string[] = [];
  (fake.ctx.sapiom as Record<string, unknown>).connectors = {
    slack: {
      async replies({ channel }: { channel: string }) {
        calls.push(`replies ${channel}`);
        throw {
          status: 200,
          body: { error: opts.channels?.[channel] ?? "thread_not_found" },
        };
      },
      async userInfo({ user }: { user: string }) {
        const name = opts.users?.[user];
        if (!name) throw { status: 200, body: { error: "user_not_found" } };
        return { ok: true, user: { id: user, name } };
      },
    },
    linear: {
      async listTools() {
        if (opts.linear instanceof Error) throw opts.linear;
        return Object.keys(opts.linear ?? {}).map((name) => ({ name }));
      },
      async callTool(name: string) {
        calls.push(`linear ${name}`);
        const out = (opts.linear as Record<string, unknown>)[name];
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      },
    },
  };
  return { ...fake, calls };
}

describe("probes", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    await prepareDatabase(
      db,
      input({
        desks: [DESK],
        config: {
          "channels.customer": [
            { channelId: "C0REALCUS1", accountName: "Acme" },
            { channelId: "C0REALCUS2", accountName: "Bolt" },
          ],
        },
      }),
    );
  });

  it("checks every triage and customer channel and the on-call user", async () => {
    const t = connectorCtx({
      channels: { C0REALCUS2: "not_in_channel" },
      users: { U0REALONC1: "dana" },
    });
    const checks = await probeSlack(t.ctx as never, db);
    expect(checks.map((c) => [c.target, c.ok])).toEqual([
      ["desk support triage channel C0REALTRI1", true],
      ["desk support on-call U0REALONC1", true],
      ["customer channel Acme C0REALCUS1", true],
      ["customer channel Bolt C0REALCUS2", false],
    ]);
    expect(checks[1].detail).toBe("resolves to dana");
    expect(checks[3].fix).toMatch(/fails silently/);
  });

  it("reports an on-call id Slack cannot resolve", async () => {
    const checks = await probeSlack(connectorCtx({}).ctx as never, db);
    expect(checks[1]).toMatchObject({ ok: false, detail: "user_not_found" });
  });

  it("lists Linear teams and projects when the connector answers", async () => {
    const t = connectorCtx({
      linear: {
        list_teams: [{ id: "t1", name: "Core", key: "COR" }],
        list_projects: {
          projects: [{ id: "p1", name: "Support", teams: ["Core"] }],
        },
        save_issue: null,
      },
    });
    expect(await probeLinear(t.ctx as never)).toEqual({
      check: {
        target: "linear connector",
        ok: true,
        detail: "connected (3 tools)",
      },
      linear: {
        teams: [{ id: "t1", name: "Core", key: "COR" }],
        projects: [{ id: "p1", name: "Support", teams: ["Core"] }],
      },
    });
    expect(t.calls).toEqual(["linear list_teams", "linear list_projects"]);
  });

  it("says how to connect Linear when the relay refuses", async () => {
    const out = await probeLinear(
      connectorCtx({ linear: new Error("relay 404: no linear connector") })
        .ctx as never,
    );
    expect(out.linear).toBeNull();
    expect(out.check).toMatchObject({ ok: false });
    expect(out.check.fix).toMatch(/relay slug 'linear'/);
  });
});

describe("agent on a local trace", () => {
  type Directive = {
    kind: string;
    output?: Record<string, unknown>;
    stepName?: string;
    input?: unknown;
  };
  const step = (name: string) =>
    agent.steps[name] as unknown as {
      run: (i: unknown, c: unknown) => Promise<Directive>;
    };
  afterEach(() => setLocalDb(undefined));

  it("walks database then connectors and ends with a report, posting nothing", async () => {
    setLocalDb(await localFleetDb());
    const t = fakeCtx({ isLocalTrace: true });
    const first = await step("database").run(input({}), t.ctx);
    expect(first).toMatchObject({ kind: "continue", stepName: "connectors" });
    const last = await step("connectors").run(first.input, t.ctx);
    expect(last.kind).toBe("terminate");
    const out = last.output as {
      database: { desks: { slug: string }[] };
      checks: { target: string; ok: boolean }[];
      next: string[];
    };
    // A local trace's database is seeded from fleet.json's example desk.
    expect(out.database.desks.map((d) => d.slug)).toEqual(["support"]);
    expect(out.checks.every((c) => c.ok)).toBe(true);
    expect(out.next.some((s) => /knowledge.docs_url/.test(s))).toBe(true);
    expect(t.logs.filter((l) => /chat\.postMessage/.test(l.msg))).toHaveLength(
      0,
    );
  });
});
