/** watchdog: pure rules, then one `sapiom.run.failed` event against an in-memory database. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/index";
import { setConfig } from "../../_shared/config";
import { memoryDb, setLocalDb, type Db } from "../../_shared/db";
import { upsertDesk } from "../../_shared/desks";
import { RunFailed } from "../../_shared/events";
import { fakeCtx } from "../../_shared/test-ctx";
import { agentSlug } from "../../_shared/fleet-id";
import fleet from "../../fleet.json";
import { agent, report } from "./index";
import {
  actionItems,
  describeFailure,
  failureKey,
  failureMessage,
  isWatched,
  runUrl,
  WATCHED_SLUGS,
} from "./logic";

/** The fixture's failure, with the slug this checkout's fleet id gives the copilot. */
const event = (over: Partial<RunFailed> = {}): RunFailed => ({
  ...RunFailed.parse(fixture("watchdog/run-failed.json").payload),
  slug: agentSlug("copilot"),
  ...over,
});

describe("fleet.json", () => {
  it("starts the watchdog on sapiom.run.failed and on nothing else", () => {
    expect(fleet.triggers.filter((t) => t.project === "watchdog")).toEqual([
      { project: "watchdog", kind: "event", eventType: "sapiom.run.failed" },
    ]);
  });
});

describe("the entry schema", () => {
  it("declares every payload field, since the engine passes only declared keys", () => {
    const payload = fixture("watchdog/run-failed.json").payload;
    expect(Object.keys(RunFailed.shape).sort()).toEqual(
      Object.keys(payload).sort(),
    );
    expect(agent.steps.notify.inputSchema).toBe(RunFailed);
  });

  it("accepts an event whose descriptive fields are null", () => {
    const parsed = RunFailed.safeParse({
      definitionId: "d",
      slug: "s",
      executionId: "e",
      definitionName: null,
      failedStep: null,
      attempt: null,
      faultClass: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(parsed.error?.issues).toBeUndefined();
  });
});

describe("isWatched", () => {
  it("watches the fleet's agents, not itself, the smoke agents or another fleet", () => {
    expect(isWatched(agentSlug("copilot"))).toBe(true);
    expect(isWatched(agentSlug("digest"))).toBe(true);
    expect(isWatched(agentSlug("watchdog"))).toBe(false);
    expect(isWatched(agentSlug("smoke-ingest"))).toBe(false);
    expect(isWatched(agentSlug("copilot", "other-desk"))).toBe(false);
    expect(isWatched("price-checker")).toBe(false);
    expect(WATCHED_SLUGS).toHaveLength(7);
  });
});

describe("failureKey", () => {
  it("tells a resumed run's second failure from its first", () => {
    const first = failureKey(event());
    expect(first).toBe(failureKey(event()));
    expect(
      failureKey(event({ finishedAt: "2026-10-04T11:00:00.000Z" })),
    ).not.toBe(first);
  });
});

describe("actionItems", () => {
  const has = (items: string[], re: RegExp) => items.some((i) => re.test(i));

  it("on an infra fault, says the step's code did not fail and to replay", () => {
    const items = actionItems(agentSlug("intake"), "classify", "infra");
    expect(has(items, /step's code did not fail/)).toBe(true);
    expect(has(items, /Replay the run/)).toBe(true);
    expect(has(items, /read the/)).toBe(false);
  });

  it("on a workload fault, points at the step's error and the common causes", () => {
    const items = actionItems(agentSlug("intake"), "classify", "workload");
    expect(items[0]).toBe("Open the run and read the classify step's error.");
    expect(has(items, /invite the Slack bot/)).toBe(true);
    expect(has(items, /rerun setup/)).toBe(true);
    expect(has(items, /transient/)).toBe(true);
    expect(has(items, /Replay the run/)).toBe(true);
    expect(has(items, /Linear/)).toBe(false);
  });

  it("tells the team to reply by hand when the copilot fails", () => {
    const items = actionItems(agentSlug("copilot"), "draft", "workload");
    expect(has(items, /reply to the customer by hand/)).toBe(true);
  });

  it.each(["escalation", "linear-sync"])("names Linear for %s", (key) => {
    const items = actionItems(agentSlug(key), "run", null);
    expect(has(items, /reconnect Linear in Connectors/)).toBe(true);
  });
});

describe("failureMessage", () => {
  const msg = failureMessage(describeFailure(event(), 42));
  const all = JSON.stringify(msg.blocks);

  it("names the agent, step and attempt counted from 1, the fault and the issue", () => {
    expect(msg.text).toBe(
      `:rotating_light: ${agentSlug("copilot")} failed at draft (attempt 3)`,
    );
    expect(all).toContain("workload (the step's code)");
    expect(all).toContain("Issue: #42");
    expect(all).toContain("*Action items*");
  });

  it("links the run", () => {
    const e = event();
    expect(all).toContain(
      `<${runUrl(e.definitionId, e.executionId)}|Open the run>`,
    );
    expect(all).toContain(`run \`${e.executionId}\``);
  });

  it("leaves out what the event did not carry", () => {
    const bare = failureMessage(
      describeFailure(
        event({
          failedStep: null,
          attempt: null,
          faultClass: null,
          finishedAt: null,
        }),
        null,
      ),
    );
    const text = JSON.stringify(bare.blocks);
    expect(bare.text).toBe(
      `:rotating_light: ${agentSlug("copilot")} failed at unknown`,
    );
    expect(text).not.toContain("Fault:");
    expect(text).not.toContain("Issue:");
    expect(text).toContain("finished unknown");
  });

  it("escapes a step name that would otherwise be read as a mention", () => {
    const m = failureMessage(
      describeFailure(event({ failedStep: "<!channel>" }), null),
    );
    expect(m.text).not.toContain("<!");
    expect(JSON.stringify(m.blocks)).not.toContain("<!channel>");
  });
});

const posts = (logs: { msg: string; data?: unknown }[]) =>
  logs
    .filter((l) => l.msg.startsWith("slack chat.postMessage"))
    .map((l) => (l.data as { args: { channel: string; text: string } }).args);

describe("report", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    await setConfig(db, "channels.triage", "C0TRIAGE001", "test");
  });
  const run = (e: RunFailed) => {
    const c = fakeCtx({ isLocalTrace: true });
    return { ...c, done: report(c.ctx, db, e) };
  };

  it("posts a failure once, so a redelivered event posts nothing", async () => {
    const first = run(event());
    expect(await first.done).toMatchObject({
      outcome: "posted",
      channel: "C0TRIAGE001",
    });
    expect(posts(first.logs)).toHaveLength(1);
    expect(posts(first.logs)[0].text).toContain(
      `${agentSlug("copilot")} failed at draft`,
    );

    const again = run(event());
    expect(await again.done).toMatchObject({ outcome: "already_reported" });
    expect(posts(again.logs)).toEqual([]);
  });

  it("posts a resumed run's second failure", async () => {
    await run(event()).done;
    const second = run(event({ finishedAt: "2026-10-04T11:00:00.000Z" }));
    expect(await second.done).toMatchObject({ outcome: "posted" });
    expect(posts(second.logs)).toHaveLength(1);
  });

  it("ignores another agent's failure without touching the database", async () => {
    const other = RunFailed.parse(
      fixture("watchdog/run-failed.other-agent.json").payload,
    );
    const r = run(other);
    expect(await r.done).toEqual({
      outcome: "not_this_fleet",
      slug: "price-checker",
    });
    expect(posts(r.logs)).toEqual([]);
    expect(await db.query("select * from watchdog_alerts")).toEqual([]);
  });

  it("uses alerts.channel when set", async () => {
    await setConfig(db, "alerts.channel", "C0ALERTS01", "test");
    const r = run(event());
    await r.done;
    expect(posts(r.logs)[0].channel).toBe("C0ALERTS01");
  });

  it("prefers the default desk's triage channel to the legacy channels.triage", async () => {
    await upsertDesk(db, {
      slug: "support",
      name: "Support",
      triageChannel: "C0DESKTRI01",
      isDefault: true,
    });
    const r = run(event());
    await r.done;
    expect(posts(r.logs)[0].channel).toBe("C0DESKTRI01");
  });

  it("names the issue the failed run worked on", async () => {
    await db.query(
      "insert into accounts (id, name, slack_channel_id) values ('a1b2c3d4-0000-4000-8000-000000000001', 'Acme', 'C0ACME')",
    );
    const [{ id, number }] = await db.query<{ id: string; number: number }>(
      "insert into issues (account_id, source) values ('a1b2c3d4-0000-4000-8000-000000000001', 'slack') returning id, number",
    );
    const e = event();
    await db.query(
      "insert into runs (execution_id, agent, issue_id) values ($1, $2, $3)",
      [e.executionId, e.slug, id],
    );
    const r = run(e);
    await r.done;
    const [args] = posts(r.logs) as unknown as { blocks: unknown[] }[];
    expect(JSON.stringify(args.blocks)).toContain(`Issue: #${number}`);
  });

  it("records nothing when the post fails, so a retry posts it", async () => {
    const { ctx } = fakeCtx();
    const failing = {
      ...ctx,
      sapiom: {
        connectors: {
          slack: {
            postMessage: async () => {
              throw Object.assign(new Error("no"), {
                status: 200,
                body: { error: "not_in_channel" },
              });
            },
          },
        },
      },
    };
    await expect(report(failing, db, event())).rejects.toThrow(
      /not_in_channel/,
    );
    expect(await db.query("select * from watchdog_alerts")).toEqual([]);
    const retry = run(event());
    expect(await retry.done).toMatchObject({ outcome: "posted" });
  });

  it("fails when there is no channel to alert", async () => {
    const empty = await memoryDb();
    const c = fakeCtx({ isLocalTrace: true });
    await expect(report(c.ctx, empty, event())).rejects.toThrow(
      /alert channel/,
    );
  });
});

describe("watchdog step", () => {
  const step = agent.steps.notify as unknown as {
    run: (i: unknown, c: unknown) => Promise<{ output?: unknown }>;
  };
  afterEach(() => setLocalDb(undefined));

  it("posts the fixture's failure on a local trace", async () => {
    const db = await memoryDb();
    await setConfig(db, "channels.triage", "C0TRIAGE001", "test");
    setLocalDb(db);
    const { ctx, logs } = fakeCtx({ isLocalTrace: true });
    const done = await step.run(event(), ctx);
    expect(done.output).toMatchObject({ outcome: "posted" });
    expect(posts(logs)).toHaveLength(1);
  });

  it("drops another fleet's failure before opening the database", async () => {
    const { ctx } = fakeCtx({ isLocalTrace: true });
    const other = fixture("watchdog/run-failed.other-agent.json").payload;
    const done = await step.run(other, ctx);
    expect(done.output).toEqual({
      outcome: "not_this_fleet",
      slug: "price-checker",
    });
  });
});
