/**
 * The On Hold check: the pure state mapping and backoff, and the live path against a mocked Linear
 * relay. `sync` below does for every issue what the controller's tick does for its one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectors } from "@sapiom/tools";

import { localFleetDb, type Db } from "./db";
import { setConfig } from "./config";
import { defaultDesk, upsertDesk } from "./desks";
import {
  accountByChannel,
  getIssue,
  messageBySourceEventId,
  openIssue,
  setCardDirty,
  setStatus,
  setTriageRoot,
  updateIssue,
} from "./issues";
import {
  checkLinear,
  linearCheckDue,
  nextLinearCheck,
  redrawIfDirty,
  resolution,
  resolveByHand,
  syncKey,
  type LinearCheck,
  type Resolution,
} from "./linear-check";
import { EXAMPLE_SLA, fakeCtx } from "./test-ctx";

/**
 * Every On Hold issue's tick at once: redraw a stale card, then read the Linear issue. Returns
 * what was read, moved and failed.
 */
async function sync(ctx: never, db: Db) {
  const rows = await db.query<{ id: string }>(
    "select id from issues where card_dirty or (status = 'on_hold' and linear_identifier is not null) order by number",
  );
  const checks: LinearCheck[] = [];
  for (const { id } of rows) {
    const issue = await getIssue(db, id);
    await redrawIfDirty(ctx, db, issue);
    const check = await checkLinear(ctx, db, issue, "test-controller");
    if (check) checks.push(check);
  }
  return {
    checked: checks.length,
    resolved: checks
      .filter((c) => c.resolution)
      .map((c) => ({
        issueId: c.issueId,
        linearIdentifier: c.linearIdentifier,
        resolution: c.resolution,
      })),
    failed: checks
      .filter((c) => c.error)
      .map((c) => ({ issueId: c.issueId, error: c.error })),
  };
}

describe("resolution", () => {
  it.each([
    [{ statusType: "completed", status: "Done" }, "done"],
    [{ statusType: "completed", status: "Shipped" }, "done"],
    [{ statusType: "canceled", status: "Canceled" }, "canceled"],
    [{ statusType: "cancelled" }, "canceled"],
    [{ statusType: "started", status: "In Progress" }, null],
    [{ statusType: "unstarted", status: "Todo" }, null],
    [{ statusType: "backlog" }, null],
    // The name counts only when the reply has no type.
    [{ status: "Done" }, "done"],
    [{ status: "Canceled" }, "canceled"],
    [{ statusType: "started", status: "Done" }, null],
    [{}, null],
  ])("%j -> %s", (linear, expected) => {
    expect(resolution(linear)).toBe(expected);
  });
});

describe("nextLinearCheck", () => {
  const t0 = new Date("2026-10-04T10:00:00Z");
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  it.each([
    ["never read", null, 60],
    ["read before it went On Hold", at(-30), 60],
    ["read at 30 min (a customer message)", at(30), 60],
    ["read at the 1 h point", at(60), 300],
    ["read at 2 h", at(120), 300],
    ["read at the 5 h point", at(300), 300 + 1440],
    ["read at 1 day", at(1440), 300 + 1440],
    ["read at the first daily point", at(300 + 1440), 300 + 2 * 1440],
    ["read 3 days in", at(3 * 1440), 300 + 3 * 1440],
  ])("%s", (_, checkedAt, minutes) => {
    expect(nextLinearCheck(t0, checkedAt)).toEqual(at(minutes));
  });

  it("is due only for an On Hold issue with a Linear link", () => {
    const base = {
      status: "on_hold" as const,
      linearIdentifier: "SAP-1",
      onHoldAt: t0,
      updatedAt: t0,
      linearCheckedAt: null,
    };
    expect(linearCheckDue(base)).toEqual(at(60));
    expect(linearCheckDue({ ...base, status: "on_you" })).toBeNull();
    expect(linearCheckDue({ ...base, linearIdentifier: null })).toBeNull();
    // An issue escalated before on_hold_at existed counts from its last update.
    expect(
      linearCheckDue({ ...base, onHoldAt: null, updatedAt: at(10) }),
    ).toEqual(at(70));
  });
});

describe("the On Hold check against the relay (mocked fetch)", () => {
  let db: Db;
  const ids: string[] = [];
  /** Linear state by identifier; a missing entry makes get_issue fail. */
  let states: Record<string, { status: string; statusType: string }>;
  let calls: { tool?: string; method: string; args: Record<string, unknown> }[];

  const newOnHold = async (n: number, linear = `SAP-${n}`) => {
    const account = (await accountByChannel(db, "C0CUSTOMER1"))!;
    const issue = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "high",
      title: `Issue ${n}`,
      customer: { channel: "C0CUSTOMER1", ts: `1790889355.98${n}` },
      triageRootTs: `1790889356.00${n}`,
    });
    await updateIssue(db, issue.id, {
      linearIssueId: `uuid-${linear}`,
      linearIdentifier: linear,
      linearUrl: `https://linear.app/x/issue/${linear}`,
    });
    await setStatus(db, issue.id, "on_hold");
    ids.push(issue.id);
    return issue.id;
  };

  beforeEach(async () => {
    vi.stubEnv("SAPIOM_API_KEY", "sat_test");
    db = await localFleetDb();
    ids.length = 0;
    states = {};
    calls = [];
    let ts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (url.includes("/connectors/v1/linear/mcp")) {
          const name = body.params.name as string;
          const id = body.params.arguments.id as string;
          calls.push({
            tool: name,
            method: "mcp",
            args: body.params.arguments,
          });
          const identifier = id.replace(/^uuid-/, "");
          const state = states[identifier];
          if (!state)
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  isError: true,
                  content: [{ type: "text", text: "Entity not found" }],
                },
              }),
            );
          const result = {
            id: identifier,
            uuid: `uuid-${identifier}`,
            url: `https://linear.app/x/issue/${identifier}`,
            ...state,
          };
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }],
              },
            }),
          );
        }
        const method = url.split("/methods/")[1];
        calls.push({ method, args: body });
        return new Response(
          JSON.stringify({ channel: body.channel, ts: `1790900000.00${++ts}` }),
        );
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const keyOf = async (id: string, identifier: string, r: Resolution) =>
    syncKey(id, identifier, r, (await getIssue(db, id)).onHoldAt!.getTime());
  /** A live ctx whose Slack connector is `connectors.slack` with some methods replaced. */
  const withSlack = (overrides: Record<string, unknown>) => {
    const out = fakeCtx({ isLocalTrace: false });
    const ctx = out.ctx as unknown as Record<string, unknown>;
    ctx.sapiom = {
      ...(ctx.sapiom as object),
      connectors: { slack: { ...connectors.slack, ...overrides } },
    };
    return out;
  };
  const live = () => fakeCtx({ isLocalTrace: false });
  const posts = () => calls.filter((c) => c.method === "chat.postMessage");

  it("with sla set, the redrawn card shows the first-response clock", async () => {
    await setConfig(db, "sla", EXAMPLE_SLA, "test");
    await newOnHold(1);
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    await sync(live().ctx as never, db);
    const card = calls.find((c) => c.method === "chat.update")!;
    expect(JSON.stringify(card.args.blocks)).toContain(
      "*First response due:* <!date^",
    );
  });

  it("moves a Done issue to On You with one triage post, a card redraw and one emit; a second tick does nothing", async () => {
    const id = await newOnHold(1);
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    const { ctx, emitted } = live();

    const out = await sync(ctx as never, db);
    expect(out).toMatchObject({
      checked: 1,
      resolved: [
        { issueId: id, linearIdentifier: "SAP-1", resolution: "done" },
      ],
      failed: [],
    });
    expect(calls.find((c) => c.tool)).toMatchObject({
      tool: "get_issue",
      args: { id: "uuid-SAP-1" },
    });
    expect((await getIssue(db, id)).status).toBe("on_you");
    expect(posts()).toHaveLength(1);
    expect(posts()[0].args).toMatchObject({
      channel: "C0TRIAGE001",
      threadTs: "1790889356.001",
      text: "Engineering marked <https://linear.app/x/issue/SAP-1|SAP-1> Done. Reply to the customer.",
    });
    expect((posts()[0].args.blocks as { block_id: string }[])[0].block_id).toBe(
      `sylon:${await keyOf(id, "SAP-1", "done")}`,
    );
    expect(calls.filter((c) => c.method === "chat.update")).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "issue.engineering_resolved",
      id: `issue.engineering_resolved:${await keyOf(id, "SAP-1", "done")}`,
      payload: {
        issueId: id,
        linearIdentifier: "SAP-1",
        linearState: "Done",
      },
    });
    expect(
      await messageBySourceEventId(db, await keyOf(id, "SAP-1", "done")),
    ).toMatchObject({ issueId: id, direction: "internal" });

    const before = calls.length;
    const again = await sync(ctx as never, db);
    expect(again).toMatchObject({ checked: 0, resolved: [] });
    expect(calls).toHaveLength(before);
    expect(emitted).toHaveLength(1);
  });

  it("does not repost the triage message when the move is retried", async () => {
    const id = await newOnHold(1);
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    const { ctx } = live();
    // The emit fails once: the move rolls back, the committed triage post stays.
    const failing = {
      ...ctx,
      sapiom: {
        events: {
          emit: vi.fn().mockRejectedValueOnce(new Error("gateway down")),
        },
      },
    };
    const first = await sync(failing as never, db);
    expect(first.failed).toHaveLength(1);
    expect((await getIssue(db, id)).status).toBe("on_hold");

    const { ctx: ok, emitted } = live();
    const second = await sync(ok as never, db);
    expect(second.resolved).toHaveLength(1);
    expect((await getIssue(db, id)).status).toBe("on_you");
    expect(posts()).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it("two overlapping ticks act once", async () => {
    await newOnHold(1);
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    const a = live();
    const b = live();
    await Promise.all([sync(a.ctx as never, db), sync(b.ctx as never, db)]);
    expect(posts()).toHaveLength(1);
    expect(a.emitted.length + b.emitted.length).toBe(1);
  });

  it("posts a cancel in the triage thread only: moves to On You, emits nothing, no customer message", async () => {
    const id = await newOnHold(1);
    states["SAP-1"] = { status: "Canceled", statusType: "canceled" };
    await setConfig(db, "linear_sync.notify_customer", true, "test");
    const { ctx, emitted } = live();

    const out = await sync(ctx as never, db);
    expect(out.resolved).toEqual([
      { issueId: id, linearIdentifier: "SAP-1", resolution: "canceled" },
    ]);
    expect((await getIssue(db, id)).status).toBe("on_you");
    expect(posts()).toHaveLength(1);
    expect(posts()[0].args).toMatchObject({
      channel: "C0TRIAGE001",
      text: "<https://linear.app/x/issue/SAP-1|SAP-1> was canceled in Linear.",
    });
    expect(emitted).toHaveLength(0);
  });

  it("leaves an issue whose Linear issue is still open, and stamps the check", async () => {
    const id = await newOnHold(1);
    states["SAP-1"] = { status: "In Progress", statusType: "started" };
    const { ctx, emitted } = live();
    const out = await sync(ctx as never, db);
    expect(out).toMatchObject({ checked: 1, resolved: [], failed: [] });
    expect((await getIssue(db, id)).status).toBe("on_hold");
    expect(posts()).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    const rows = await db.query<{ linear_checked_at: unknown }>(
      "select linear_checked_at from issues where id = $1",
      [id],
    );
    expect(rows[0].linear_checked_at).not.toBeNull();
    expect((await getIssue(db, id)).linearState).toBe("In Progress");

    // The next read replaces the stored state.
    states["SAP-1"] = { status: "In Review", statusType: "started" };
    await sync(live().ctx as never, db);
    expect((await getIssue(db, id)).linearState).toBe("In Review");
  });

  it("tells the customer on Done only when notify_customer is true", async () => {
    await newOnHold(1);
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    // Not set in the database at all: the fallback is off.
    await sync(live().ctx as never, db);
    expect(posts().map((p) => p.args.channel)).toEqual(["C0TRIAGE001"]);

    calls.length = 0;
    const id = await newOnHold(2);
    states["SAP-2"] = { status: "Done", statusType: "completed" };
    await setConfig(db, "linear_sync.notify_customer", true, "test");
    await sync(live().ctx as never, db);
    expect(
      posts().map((p) => [p.args.channel, p.args.threadTs, p.args.text]),
    ).toEqual([
      [
        "C0TRIAGE001",
        "1790889356.002",
        "Engineering marked <https://linear.app/x/issue/SAP-2|SAP-2> Done. Reply to the customer.",
      ],
      [
        "C0CUSTOMER1",
        "1790889355.982",
        "Our engineering team has shipped a fix for this. Let us know if you still see the problem.",
      ],
    ]);
    expect(
      await messageBySourceEventId(
        db,
        `${await keyOf(id, "SAP-2", "done")}:customer`,
      ),
    ).toMatchObject({ direction: "agent" });
  });

  it("logs a Linear error and still handles the other issues", async () => {
    const broken = await newOnHold(1);
    const fine = await newOnHold(2);
    // SAP-1 has no state: get_issue returns an error.
    states["SAP-2"] = { status: "Done", statusType: "completed" };
    const { ctx, logs, emitted } = live();

    const out = await sync(ctx as never, db);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].issueId).toBe(broken);
    expect(out.resolved.map((r) => r.issueId)).toEqual([fine]);
    expect(logs.some((l) => l.level === "error")).toBe(true);
    expect((await getIssue(db, broken)).status).toBe("on_hold");
    expect((await getIssue(db, fine)).status).toBe("on_you");
    expect(emitted).toHaveLength(1);
  });

  it("keeps the triage post when the customer post fails, and does not repost it on the next tick", async () => {
    const id = await newOnHold(1);
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    await setConfig(db, "linear_sync.notify_customer", true, "test");
    let failCustomer = true;
    const flaky = () =>
      withSlack({
        postMessage: async (a: { channel: string }) => {
          if (failCustomer && a.channel === "C0CUSTOMER1")
            throw new Error("slack down");
          return connectors.slack.postMessage(a as never);
        },
      });
    const first = await sync(flaky().ctx as never, db);
    expect(first.failed).toHaveLength(1);
    expect((await getIssue(db, id)).status).toBe("on_hold");
    expect(
      await messageBySourceEventId(db, await keyOf(id, "SAP-1", "done")),
    ).not.toBeNull();

    failCustomer = false;
    calls.length = 0;
    const second = await sync(flaky().ctx as never, db);
    expect(second.resolved).toHaveLength(1);
    expect(posts().map((p) => p.args.channel)).toEqual(["C0CUSTOMER1"]);
  });

  it("retries a failed card redraw on the next tick, after the issue has left On Hold", async () => {
    const id = await newOnHold(1);
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    let failUpdate = true;
    const flaky = () =>
      withSlack({
        update: async (a: unknown) => {
          if (failUpdate) throw new Error("slack down");
          return connectors.slack.update(a as never);
        },
      });
    await sync(flaky().ctx as never, db);
    expect((await getIssue(db, id)).status).toBe("on_you");
    expect((await getIssue(db, id)).cardDirty).toBe(true);

    failUpdate = false;
    calls.length = 0;
    await sync(flaky().ctx as never, db);
    expect(calls.filter((c) => c.method === "chat.update")).toHaveLength(1);
    expect((await getIssue(db, id)).cardDirty).toBe(false);

    calls.length = 0;
    await sync(live().ctx as never, db);
    expect(calls.filter((c) => c.method === "chat.update")).toHaveLength(0);
  });

  it("posts the notice top-level in the triage channel when the issue has no triage thread", async () => {
    const id = await newOnHold(1);
    await db.query("update issues set triage_root_ts = null where id = $1", [
      id,
    ]);
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    await sync(live().ctx as never, db);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].args.channel).toBe("C0TRIAGE001");
    expect(posts()[0].args.threadTs).toBeUndefined();
    expect((await getIssue(db, id)).status).toBe("on_you");
  });

  it("posts and redraws each issue in its own desk's triage channel", async () => {
    const onSupport = await newOnHold(1);
    const test = (
      await upsertDesk(db, {
        slug: "test",
        name: "Test",
        triageChannel: "C0TESTTRI01",
      })
    ).desk;
    const onTest = await newOnHold(2);
    await db.query("update issues set desk_id = $1 where id = $2", [
      test.id,
      onTest,
    ]);
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    states["SAP-2"] = { status: "Done", statusType: "completed" };
    await sync(live().ctx as never, db);
    const channelOf = (ts: string) =>
      [...posts(), ...calls.filter((c) => c.method === "chat.update")]
        .filter((c) => c.args.threadTs === ts || c.args.ts === ts)
        .map((c) => c.args.channel);
    expect(channelOf("1790889356.001")).toEqual(["C0TRIAGE001", "C0TRIAGE001"]);
    expect(channelOf("1790889356.002")).toEqual(["C0TESTTRI01", "C0TESTTRI01"]);
    expect((await getIssue(db, onSupport)).status).toBe("on_you");
    expect((await getIssue(db, onTest)).status).toBe("on_you");
  });

  it("after the desk's triage channel moves, posts and redraws in each card's channel", async () => {
    const resolved = await newOnHold(1);
    const dirty = await newOnHold(2);
    await setStatus(db, dirty, "on_you");
    await setCardDirty(db, dirty, true);
    for (const [id, ts] of [
      [resolved, "1790889356.001"],
      [dirty, "1790889356.002"],
    ])
      await setTriageRoot(db, id, "C0TRIAGE001", ts);
    const support = (await defaultDesk(db))!;
    await upsertDesk(
      db,
      { ...support, triageChannel: "C0NEW" },
      { overwrite: true },
    );
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    await sync(live().ctx as never, db);
    const slack = [
      ...posts(),
      ...calls.filter((c) => c.method === "chat.update"),
    ];
    const channelOf = (ts: string) =>
      slack
        .filter((c) => c.args.threadTs === ts || c.args.ts === ts)
        .map((c) => c.args.channel);
    expect(channelOf("1790889356.001")).toEqual(["C0TRIAGE001", "C0TRIAGE001"]);
    expect(channelOf("1790889356.002")).toEqual(["C0TRIAGE001"]);
    expect(slack.some((c) => c.args.channel === "C0NEW")).toBe(false);
  });

  it("keys a repeat escalation of the same issue and Linear identifier apart", async () => {
    const id = await newOnHold(1);
    states["SAP-1"] = { status: "Done", statusType: "completed" };
    const { ctx, emitted } = live();
    await sync(ctx as never, db);
    await new Promise((r) => setTimeout(r, 5));
    await setStatus(db, id, "on_hold");
    await sync(ctx as never, db);
    expect(posts()).toHaveLength(2);
    expect(emitted).toHaveLength(2);
    expect(new Set(emitted.map((e) => e.id)).size).toBe(2);
  });

  it("Resolved moves the issue On You without reading Linear, once", async () => {
    const id = await newOnHold(1);
    const { ctx, emitted } = live();
    const moved = await resolveByHand(
      ctx as never,
      db,
      "C0TRIAGE001",
      await getIssue(db, id),
      "U0CLICKER1",
    );
    expect(moved?.status).toBe("on_you");
    expect(calls.filter((c) => c.tool)).toHaveLength(0);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].args).toMatchObject({
      channel: "C0TRIAGE001",
      threadTs: "1790889356.001",
      text: "Marked resolved by <@U0CLICKER1> (<https://linear.app/x/issue/SAP-1|SAP-1>). Reply to the customer.",
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "issue.engineering_resolved",
        id: `issue.engineering_resolved:${await keyOf(id, "SAP-1", "resolved")}`,
        payload: expect.objectContaining({
          linearIdentifier: "SAP-1",
          linearState: "Resolved in Slack",
        }),
      }),
    ]);

    // A second click finds it On You and does nothing.
    const again = await resolveByHand(
      ctx as never,
      db,
      "C0TRIAGE001",
      await getIssue(db, id),
      "U0CLICKER1",
    );
    expect(again).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });
});
