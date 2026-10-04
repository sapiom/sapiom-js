/**
 * Console ticket actions: which buttons a ticket offers, and that the click the Console emits is
 * handled by intake and the copilot exactly as a Slack click is (real step code on a local trace).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { decodeAction } from "../../_shared/blocks";
import { localFleetDb, setLocalDb, type Db } from "../../_shared/db";
import { defaultDesk, type Desk } from "../../_shared/desks";
import { getDraft, getIssue } from "../../_shared/issues";
import { fakeCtx } from "../../_shared/test-ctx";
import { agent as copilot } from "../../agents/copilot/index";
import {
  FIXTURE_DRAFT,
  FIXTURE_ISSUE,
  seedLocalFixtures,
} from "../../agents/copilot/local";
import { agent as intake } from "../../agents/intake/index";
import {
  ACTION_TYPE,
  CONSOLE_ACTOR,
  planAction,
  type ActionTarget,
} from "./actions";
import { deskTicket } from "./queries";

type Directive = {
  kind: string;
  stepName?: string;
  input?: unknown;
  output?: Record<string, unknown>;
};
type Steps = Record<
  string,
  {
    inputSchema?: { parse: (x: unknown) => unknown };
    run: (i: unknown, c: unknown) => Promise<Directive>;
  }
>;

/** Walk an agent from its entry the way the engine does: parse each step's input, follow gotos. */
async function run(
  a: { entry: string; steps: unknown },
  input: unknown,
  executionId: string,
) {
  const made = fakeCtx({ isLocalTrace: true, executionId });
  let name = a.entry;
  let value = input;
  for (;;) {
    const step = (a.steps as Steps)[name]!;
    const parsed = step.inputSchema ? step.inputSchema.parse(value) : value;
    const d = await step.run(parsed, made.ctx);
    if (d.kind !== "continue") {
      const slack = (method: string) =>
        made.logs
          .filter((l) => l.msg.startsWith(`slack ${method} `))
          .map((l) => (l.data as { args: Record<string, unknown> }).args);
      return { output: d.output ?? {}, emitted: made.emitted, slack };
    }
    name = d.stepName!;
    value = d.input;
  }
}

const target = (
  over: Partial<ActionTarget["issue"]> = {},
  draft = true,
): ActionTarget => ({
  issue: {
    id: "11111111-1111-4111-8111-111111111111",
    status: "new",
    ownerSlackId: null,
    triageRootTs: "1790000000.000100",
    ...over,
  },
  triageChannel: "C0TRIAGE",
  draft: draft
    ? {
        id: "22222222-2222-4222-8222-222222222222",
        cardChannel: "C0TRIAGE",
        cardTs: "1790000001.000100",
      }
    : null,
});

describe("planAction", () => {
  it("builds the Slack click for an issue verb on the issue card", () => {
    const plan = planAction("close", target(), "n1");
    expect(plan).toMatchObject({
      ok: true,
      type: ACTION_TYPE,
      id: "slack.block_actions:console:n1",
    });
    if (!plan.ok) return;
    expect(plan.payload.user.id).toBe(CONSOLE_ACTOR);
    expect(plan.payload.container).toMatchObject({
      channel_id: "C0TRIAGE",
      message_ts: "1790000000.000100",
    });
    expect(decodeAction(plan.payload.actions[0]!.action_id)).toEqual({
      owner: "issue",
      verb: "close",
    });
    expect(plan.payload.actions[0]!.value).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("builds the click for a draft verb on the draft card", () => {
    const plan = planAction("approve", target(), "n2");
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.payload.container?.message_ts).toBe("1790000001.000100");
    expect(plan.payload.actions[0]).toMatchObject({
      action_id: "draft.approve",
      value: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("refuses what the Slack card would not offer", () => {
    expect(planAction("reopen", target())).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(planAction("close", target({ status: "closed" }))).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(
      planAction("take", target({ ownerSlackId: "U0OWNER" })),
    ).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(planAction("take", target({ triageRootTs: null }))).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(planAction("dismiss", target({}, false))).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("gives every click its own trigger id, so two clicks are two events", () => {
    const a = planAction("close", target());
    const b = planAction("close", target());
    if (!a.ok || !b.ok) throw new Error("expected plans");
    expect(a.id).not.toBe(b.id);
  });
});

describe("the agents handle a Console click as a Slack click", () => {
  let db: Db;
  let desk: Desk;
  beforeEach(async () => {
    setLocalDb(undefined);
    db = await localFleetDb();
    await seedLocalFixtures(db);
    setLocalDb(db);
    desk = (await defaultDesk(db))!;
  });

  async function click(verb: string) {
    const t = (await deskTicket(db, desk.id, FIXTURE_ISSUE))!;
    const plan = planAction(verb, {
      issue: t,
      triageChannel: desk.triageChannel,
      draft: t.pendingDraft,
    });
    if (!plan.ok) throw new Error(plan.reason);
    return plan.payload;
  }

  it("Take and Close go to intake; the copilot ignores them", async () => {
    const take = await click("take");
    expect((await run(copilot, take, "c-take")).output).toMatchObject({
      skipped: "not a draft action: issue.take",
    });
    const took = await run(intake, take, "i-take");
    expect(took.output).toMatchObject({
      outcome: "take",
      changed: true,
      owner: CONSOLE_ACTOR,
    });
    // The issue card redraws.
    expect(took.slack("chat.update")).toEqual([
      expect.objectContaining({ ts: "1790889400.000200" }),
    ]);

    const closed = await run(intake, await click("close"), "i-close");
    expect(closed.output).toMatchObject({ changed: true, status: "closed" });
    expect(closed.slack("chat.postMessage")).toEqual([
      expect.objectContaining({ text: "Closed by the Console" }),
    ]);
    expect(await getIssue(db, FIXTURE_ISSUE)).toMatchObject({
      status: "closed",
      ownerSlackId: CONSOLE_ACTOR,
    });
  });

  it("Approve goes to the copilot: the reply is sent, the cards redraw, intake ignores it", async () => {
    const approve = await click("approve");
    expect((await run(intake, approve, "i-approve")).output).toMatchObject({
      skipped: "not an issue action: draft.approve",
    });
    const out = await run(copilot, approve, "c-approve");
    expect(out.output).toMatchObject({
      changed: true,
      status: "approved",
      issueStatus: "on_customer",
    });
    expect(out.slack("chat.update").map((u) => u.ts)).toEqual([
      "1790889400.000200",
      "1790889450.000250",
    ]);
    expect(await getDraft(db, FIXTURE_DRAFT)).toMatchObject({
      status: "approved",
      decidedBy: CONSOLE_ACTOR,
    });
    // The Console is no Slack user, so the card names it in plain text rather than as a mention.
    expect(JSON.stringify(out.slack("chat.update")[1]!.blocks)).toContain(
      "Approved and sent by the Console",
    );
  });

  it("Escalate emits issue.escalate as the Slack click does, requested by the Console", async () => {
    const out = await run(copilot, await click("escalate"), "c-escalate");
    expect(out.output).toMatchObject({ changed: true, status: "escalated" });
    expect(out.emitted).toEqual([
      expect.objectContaining({
        type: "issue.escalate",
        payload: expect.objectContaining({
          issueId: FIXTURE_ISSUE,
          requestedBy: CONSOLE_ACTOR,
        }),
      }),
    ]);
  });

  it("Dismiss decides the draft and leaves the issue open", async () => {
    const out = await run(copilot, await click("dismiss"), "c-dismiss");
    expect(out.output).toMatchObject({ changed: true, status: "dismissed" });
    expect((await getIssue(db, FIXTURE_ISSUE)).status).toBe("new");
  });
});
