/** Both smoke agents on a local trace: real step code, in-memory database, no Slack, no network. */
import { beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../fixtures/index";
import { localFleetDb, setLocalDb, withDb } from "../_shared/db";
import { fakeCtx } from "../_shared/test-ctx";
import { agent as consume } from "./smoke-consume/index";
import { agent as ingest } from "./smoke-ingest/index";

type Directive = {
  kind: string;
  output?: Record<string, unknown>;
  target?: string;
  step?: string;
};
const step = (a: typeof ingest, name: string) =>
  a.steps[name] as unknown as {
    run: (i: unknown, c: unknown) => Promise<Directive>;
  };

describe("smoke agents", () => {
  beforeEach(() => setLocalDb(undefined));

  it("a channel message becomes an issue, a triage card, and one issue.created; consume records its run", async () => {
    // Two agents, two executions, one database: as deployed.
    setLocalDb(await localFleetDb());
    const { ctx, emitted } = fakeCtx({
      isLocalTrace: true,
      executionId: "exec-ingest",
    });
    const message = fixture("slack/message-created.channel.json").payload;

    const guarded = await step(ingest, "guard").run(message, ctx);
    expect(guarded.kind).toBe("continue");
    const done = await step(ingest, "ingest").run(message, ctx);
    expect(done.kind).toBe("terminate");
    expect(done.output).toMatchObject({
      number: 1,
      outcome: "matched",
      duplicate: false,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "issue.created",
      id: "issue.created:Ev0EXAMPLE01",
    });

    // A retry re-runs the step: same issue, no second card, the emit dedups.
    const again = await step(ingest, "ingest").run(message, ctx);
    expect(again.output).toMatchObject({
      issueId: done.output!.issueId,
      triageRootTs: done.output!.triageRootTs,
      duplicate: true,
    });

    const consumeCtx = fakeCtx({
      isLocalTrace: true,
      executionId: "exec-consume",
    }).ctx;
    const consumed = await step(consume as never, "record").run(
      emitted[0].payload,
      consumeCtx,
    );
    expect(consumed.output).toMatchObject({
      issueId: done.output!.issueId,
      number: 1,
      status: "new",
    });

    const runs = await withDb(ctx as never, (db) =>
      db.query("select execution_id, agent from runs order by execution_id"),
    );
    expect(runs).toEqual([
      { execution_id: "exec-consume", agent: "sylon-smoke-consume" },
      { execution_id: "exec-ingest", agent: "sylon-smoke-ingest" },
    ]);
  });

  it("skips thread replies and channels that are not customer channels", async () => {
    const { ctx } = fakeCtx({ isLocalTrace: true });
    const reply = fixture("slack/message-created.thread-reply.json").payload;
    expect((await step(ingest, "guard").run(reply, ctx)).output).toMatchObject({
      skipped: "thread reply",
    });
    const other = structuredClone(
      fixture("slack/message-created.channel.json").payload,
    ) as { event: { channel: string } };
    other.event.channel = "C0TRIAGE001";
    expect((await step(ingest, "guard").run(other, ctx)).output).toMatchObject({
      skipped: expect.stringMatching(/not a customer channel/),
    });
  });

  it("gives separate local traces separate databases", async () => {
    const message = fixture("slack/message-created.channel.json").payload;
    const first = await step(ingest, "ingest").run(
      message,
      fakeCtx({ isLocalTrace: true, executionId: "trace-a" }).ctx,
    );
    const second = await step(ingest, "ingest").run(
      message,
      fakeCtx({ isLocalTrace: true, executionId: "trace-b" }).ctx,
    );
    expect(first.output).toMatchObject({ number: 1, duplicate: false });
    expect(second.output).toMatchObject({ number: 1, duplicate: false });
    expect(second.output!.issueId).not.toBe(first.output!.issueId);
  });

  it("mirrors customer text with mentions made inert", async () => {
    const { ctx, logs } = fakeCtx({
      isLocalTrace: true,
      executionId: "trace-mention",
    });
    const message = structuredClone(
      fixture("slack/message-created.channel.json").payload,
    ) as { event: { text: string } };
    message.event.text = "help <!here> <@U123|bob> <!subteam^S1|@oncall>";
    await step(ingest, "ingest").run(message, ctx);
    const mirror = logs.find(
      (l) =>
        l.msg.startsWith("slack chat.postMessage") &&
        JSON.stringify(l.data).includes("threadTs"),
    );
    const text = (mirror!.data as { args: { text: string } }).args.text;
    expect(text).toContain("help @here @bob @@oncall");
    expect(text).not.toMatch(/<!|<@U123/);
  });
});
