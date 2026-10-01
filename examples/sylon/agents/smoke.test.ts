/** Both smoke agents on a local trace: real step code, in-memory database, no Slack, no network. */
import { beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../fixtures/index";
import { setLocalDb, withDb } from "../_shared/db";
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
      id: "issue.created:Ev0C67Q6T4LU",
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
    other.event.channel = "C0C67P6GQKE";
    expect((await step(ingest, "guard").run(other, ctx)).output).toMatchObject({
      skipped: expect.stringMatching(/not a customer channel/),
    });
  });
});
