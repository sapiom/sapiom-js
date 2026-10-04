/** The linear-sync agent: the pure state mapping, and the live path against a mocked Linear relay. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectors } from "@sapiom/tools";

import { fixture } from "../fixtures/index";
import { localFleetDb, setLocalDb, type Db } from "../_shared/db";
import { setConfig } from "../_shared/config";
import { upsertDesk } from "../_shared/desks";
import {
  accountByChannel,
  getIssue,
  messageBySourceEventId,
  openIssue,
  setStatus,
  updateIssue,
} from "../_shared/issues";
import { fakeCtx } from "../_shared/test-ctx";
import { agent, sync } from "./linear-sync/index";
import { resolution, syncKey } from "./linear-sync/rules";

type Directive = { kind: string; output?: Record<string, unknown> };
const run = (input: unknown, ctx: unknown) =>
  (
    agent.steps.sync as unknown as {
      run: (i: unknown, c: unknown) => Promise<Directive>;
    }
  ).run(input, ctx);

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

describe("linear-sync on a local trace", () => {
  beforeEach(() => setLocalDb(undefined));

  it("runs on the cron fixture and finds nothing to do", async () => {
    const { ctx, emitted } = fakeCtx({ isLocalTrace: true });
    const done = await run(fixture("linear-sync/cron.json").payload, ctx);
    expect(done.output).toMatchObject({ checked: 0, resolved: [], failed: [] });
    expect(emitted).toHaveLength(0);
  });
});

describe("linear-sync against the relay (mocked fetch)", () => {
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

  const keyOf = async (
    id: string,
    identifier: string,
    r: "done" | "canceled",
  ) => syncKey(id, identifier, r, (await getIssue(db, id)).onHoldAt!.getTime());
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

  it("caps reads per tick and checks the least recently checked first", async () => {
    for (let n = 1; n <= 3; n++) {
      await newOnHold(n);
      states[`SAP-${n}`] = { status: "In Progress", statusType: "started" };
    }
    const read = () =>
      calls.filter((c) => c.tool).map((c) => c.args.id as string);
    await sync(live().ctx as never, db, 2);
    expect(read()).toEqual(["uuid-SAP-1", "uuid-SAP-2"]);
    calls.length = 0;
    await sync(live().ctx as never, db, 2);
    expect(read()).toEqual(["uuid-SAP-3", "uuid-SAP-1"]);
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
});
