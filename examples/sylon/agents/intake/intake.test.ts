/** intake on a local trace: real step code, one in-memory database, no Slack, no network. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/index";
import { localFleetDb, setLocalDb, withDb, type Db } from "../../_shared/db";
import { getIssue, messagesForIssue } from "../../_shared/issues";
import { fakeCtx } from "../../_shared/test-ctx";
import {
  decide,
  IS_ISSUE_MIN,
  LINK_MIN,
  optionKey,
  questions,
  type Candidate,
  type IntakeJev,
} from "./decide";
import { agent } from "./index";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const intakeFixture = (file: string) =>
  JSON.parse(
    readFileSync(path.join(DIR, "../../fixtures/intake", file), "utf8"),
  ) as { payload: Record<string, unknown> } & Record<string, unknown>;
const JEV = intakeFixture("jev.json") as unknown as Record<string, IntakeJev>;

type Directive = {
  kind: string;
  stepName?: string;
  input?: unknown;
  output?: Record<string, unknown>;
};
type StepDef = {
  inputSchema?: { parse: (x: unknown) => unknown };
  run: (i: unknown, c: unknown) => Promise<Directive>;
};

/** Walk the agent from `guard` the way the engine does: parse each step's input, follow gotos. */
async function run(input: unknown, ctx: unknown) {
  const visited: string[] = [];
  let name = "guard";
  let value = input;
  for (;;) {
    visited.push(name);
    const step = (agent.steps as unknown as Record<string, StepDef>)[name];
    const parsed = step.inputSchema ? step.inputSchema.parse(value) : value;
    const d = await step.run(parsed, ctx);
    if (d.kind !== "continue") return { output: d.output ?? {}, visited };
    name = d.stepName!;
    value = d.input;
  }
}

function makeCtx(executionId: string, jev?: IntakeJev | Error) {
  const made = fakeCtx({ isLocalTrace: true, executionId });
  const calls: unknown[] = [];
  (made.ctx.sapiom as Record<string, unknown>).decisions = {
    async evaluate(spec: unknown) {
      calls.push(spec);
      if (jev instanceof Error) throw jev;
      if (!jev) throw new Error("unexpected decisions.evaluate");
      return { answers: jev, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const slack = (method: string) =>
    made.logs
      .filter((l) => l.msg.startsWith(`slack ${method} `))
      .map((l) => (l.data as { args: Record<string, unknown> }).args);
  return { ...made, calls, slack };
}

const asJev = (isIssue: number, linked = "new", p = 0.9): IntakeJev => ({
  is_issue: { noul: isIssue },
  category: { choice: "bug", probabilities: { bug: 1 } },
  priority: { choice: "high", probabilities: { high: 1 } },
  linked_issue: { choice: linked, probabilities: { [linked]: p } },
});

const cand: Candidate = {
  issueId: "11111111-1111-4111-8111-111111111111",
  number: 7,
  title: "Export fails",
  lastMessage: null,
};

describe("decide", () => {
  const base = { threadIssueId: null, forced: false, candidates: [cand] };

  it("opens at the is_issue threshold and ignores below it", () => {
    expect(decide({ ...base, jev: asJev(IS_ISSUE_MIN) })).toEqual({
      kind: "open",
      reason: "jev",
    });
    expect(decide({ ...base, jev: asJev(IS_ISSUE_MIN - 0.01) })).toEqual({
      kind: "ignore",
    });
  });

  it("links on a Jev pick at the link threshold, not below, and never to `new`", () => {
    const key = optionKey(cand);
    expect(LINK_MIN).toBe(0.8);
    expect(decide({ ...base, jev: asJev(0.1, key, 0.8) })).toEqual({
      kind: "link",
      issueId: cand.issueId,
      reason: "jev",
    });
    expect(decide({ ...base, jev: asJev(0.1, key, 0.79) })).toEqual({
      kind: "ignore",
    });
    // A topic-only match on an actual issue opens a new one instead of linking.
    expect(decide({ ...base, jev: asJev(0.99, key, 0.63) })).toEqual({
      kind: "open",
      reason: "jev",
    });
    expect(decide({ ...base, jev: asJev(0.9, "new", 1) }).kind).toBe("open");
    expect(decide({ ...base, jev: asJev(0.1, "issue_999", 1) }).kind).toBe(
      "ignore",
    );
  });

  it("a thread reply always links; the ticket reaction always opens; no answer opens", () => {
    expect(
      decide({ ...base, threadIssueId: cand.issueId, forced: true, jev: null }),
    ).toMatchObject({ kind: "link", reason: "thread" });
    expect(decide({ ...base, forced: true, jev: asJev(0) })).toEqual({
      kind: "open",
      reason: "ticket",
    });
    expect(decide({ ...base, jev: null })).toEqual({
      kind: "open",
      reason: "unclassified",
    });
  });

  it("offers each open issue plus `new` as link options", () => {
    expect(Object.keys(questions([cand]).linked_issue.criteria).sort()).toEqual(
      ["issue_7", "new"],
    );
  });
});

describe("intake agent", () => {
  let db: Db;
  beforeEach(async () => {
    setLocalDb(undefined);
    db = await localFleetDb();
    setLocalDb(db);
  });

  it("bug → issue + card; follow-up links; thank-you opens nothing; ticket forces one; Take; Close", async () => {
    // New bug report.
    const bug = makeCtx("exec-bug", JEV.bug);
    const opened = await run(
      intakeFixture("message-created.bug.json").payload,
      bug.ctx,
    );
    expect(opened.output).toMatchObject({ outcome: "opened", number: 1 });
    const issueId = opened.output.issueId as string;
    let issue = await getIssue(db, issueId);
    expect(issue).toMatchObject({
      status: "new",
      category: "bug",
      priority: "high",
      customerRootTs: "1790890000.000100",
    });
    expect(issue.triageRootTs).toBeTruthy();
    const posts = bug.slack("chat.postMessage");
    expect(posts.filter((p) => !p.threadTs)).toHaveLength(1);
    const mirror = posts.find((p) => p.threadTs) as { text: string };
    expect(mirror.text).toContain("@here");
    expect(mirror.text).not.toContain("<!here>");
    expect(bug.emitted.map((e) => e.id)).toEqual([
      "issue.created:Ev0INTAKEBUG1",
    ]);
    expect(bug.slack("reactions.add").map((r) => r.name)).toEqual([
      "eyes",
      "ticket",
    ]);
    expect(bug.slack("reactions.remove").map((r) => r.name)).toEqual(["eyes"]);
    const [stored] = await messagesForIssue(db, issueId);
    expect(stored.jev).toMatchObject({ is_issue: { noul: 0.94 } });

    // A redelivery of the same event: no second card, no status move, the emit dedups.
    const again = makeCtx("exec-bug-2", JEV.bug);
    expect(
      (await run(intakeFixture("message-created.bug.json").payload, again.ctx))
        .output,
    ).toMatchObject({ outcome: "opened", issueId });
    expect(again.slack("chat.postMessage")).toHaveLength(0);
    expect(again.emitted.map((e) => e.id)).toEqual([
      "issue.created:Ev0INTAKEBUG1",
    ]);

    // Follow-up in the thread: linked without asking Jev, status On You, mirrored, no new card.
    const fup = makeCtx("exec-fup");
    const linked = await run(
      intakeFixture("message-created.follow-up.json").payload,
      fup.ctx,
    );
    expect(linked.output).toMatchObject({ outcome: "linked", issueId });
    expect(fup.calls).toHaveLength(0);
    expect((await getIssue(db, issueId)).status).toBe("on_you");
    expect(fup.slack("chat.postMessage")).toEqual([
      expect.objectContaining({ threadTs: issue.triageRootTs }),
    ]);
    expect(fup.slack("chat.update")).toEqual([
      expect.objectContaining({ ts: issue.triageRootTs }),
    ]);
    expect(fup.emitted).toEqual([
      expect.objectContaining({
        type: "issue.message_added",
        id: "issue.message_added:Ev0INTAKEFUP1",
      }),
    ]);
    expect(await messagesForIssue(db, issueId)).toHaveLength(2);

    // Thank-you: stored, no issue, no ticket.
    const thx = makeCtx("exec-thx", JEV["thank-you"]);
    expect(
      (
        await run(
          intakeFixture("message-created.thank-you.json").payload,
          thx.ctx,
        )
      ).output,
    ).toMatchObject({ outcome: "not an issue", issueId: null });
    expect(thx.emitted).toHaveLength(0);
    expect(thx.slack("reactions.add").map((r) => r.name)).toEqual(["eyes"]);
    expect(thx.calls[0]).toMatchObject({
      questions: {
        linked_issue: { criteria: { issue_1: expect.any(String) } },
      },
    });

    // 🎫 on the thank-you forces an issue on the stored message.
    const tkt = makeCtx("exec-tkt", JEV["thank-you"]);
    const forced = await run(
      intakeFixture("reaction-added.ticket.json").payload,
      tkt.ctx,
    );
    expect(forced.output).toMatchObject({ outcome: "opened", number: 2 });
    expect(tkt.emitted.map((e) => e.id)).toEqual([
      "issue.created:Ev0INTAKETKT1",
    ]);
    const tktIssue = await getIssue(db, forced.output.issueId as string);
    expect(tktIssue.customerRootTs).toBe("1790890200.000300");
    // A second 🎫 (intake's own, or a teammate's) exits in guard, before any 👀.
    const tkt2 = makeCtx("exec-tkt-2");
    expect(
      await run(intakeFixture("reaction-added.ticket.json").payload, tkt2.ctx),
    ).toMatchObject({
      visited: ["guard"],
      output: { skipped: "already an issue", issueId: tktIssue.id },
    });
    expect(tkt2.slack("reactions.add")).toHaveLength(0);

    // Take from a nudge message: the card at triage_root_ts is updated, not the clicked message.
    const take = structuredClone(
      fixture("slack/block-actions.issue-take.json").payload,
    ) as {
      actions: { value: string }[];
      container: { message_ts: string };
    };
    take.actions[0].value = issueId;
    take.container.message_ts = "1790899999.000999";
    const t = makeCtx("exec-take");
    expect((await run(take, t.ctx)).output).toMatchObject({
      outcome: "take",
      changed: true,
      owner: "U0TEAMMATE1",
    });
    expect(t.slack("chat.update")).toEqual([
      expect.objectContaining({ ts: issue.triageRootTs }),
    ]);
    const t2 = makeCtx("exec-take-2");
    expect((await run(take, t2.ctx)).output).toMatchObject({ changed: false });

    // Close: status, card, one "Closed by" line; a second click changes nothing.
    const close = structuredClone(
      fixture("slack/block-actions.issue-close.json").payload,
    ) as { actions: { value: string }[] };
    close.actions[0].value = issueId;
    const c = makeCtx("exec-close");
    expect((await run(close, c.ctx)).output).toMatchObject({
      outcome: "close",
      changed: true,
      status: "closed",
    });
    expect(c.slack("chat.postMessage")).toEqual([
      expect.objectContaining({
        threadTs: issue.triageRootTs,
        text: "Closed by <@U0TEAMMATE1>",
      }),
    ]);
    const card = c.slack("chat.update")[0] as { blocks: { type: string }[] };
    expect(card.blocks.some((b) => b.type === "actions")).toBe(false);
    const c2 = makeCtx("exec-close-2");
    expect((await run(close, c2.ctx)).output).toMatchObject({ changed: false });
    expect(c2.slack("chat.postMessage")).toHaveLength(0);
    issue = await getIssue(db, issueId);
    expect(issue).toMatchObject({
      status: "closed",
      ownerSlackId: "U0TEAMMATE1",
    });
  });

  it("a follow-up on an On Hold issue stays On Hold", async () => {
    const bug = makeCtx("exec-bug", JEV.bug);
    const { output } = await run(
      intakeFixture("message-created.bug.json").payload,
      bug.ctx,
    );
    await db.query("update issues set status = 'on_hold' where id = $1", [
      output.issueId,
    ]);
    await run(
      intakeFixture("message-created.follow-up.json").payload,
      makeCtx("exec-fup").ctx,
    );
    expect((await getIssue(db, output.issueId as string)).status).toBe(
      "on_hold",
    );
  });

  it("a Jev failure still opens an unclassified issue", async () => {
    const ctx = makeCtx("exec-fail", new Error("router 503"));
    const { output } = await run(
      intakeFixture("message-created.bug.json").payload,
      ctx.ctx,
    );
    expect(output).toMatchObject({ outcome: "opened" });
    expect(await getIssue(db, output.issueId as string)).toMatchObject({
      category: "other",
      priority: "normal",
    });
  });

  it("exits early on draft.* clicks, other reactions, and non-customer channels", async () => {
    const ctx = makeCtx("exec-skip").ctx;
    const draft = await run(
      fixture("slack/block-actions.draft-approve.json").payload,
      ctx,
    );
    expect(draft).toMatchObject({
      visited: ["guard"],
      output: { skipped: expect.stringMatching(/not an issue action/) },
    });
    const reaction = structuredClone(
      intakeFixture("reaction-added.ticket.json").payload,
    ) as { event: { reaction: string } };
    reaction.event.reaction = "thumbsup";
    expect((await run(reaction, ctx)).output).toEqual({
      skipped: "reaction thumbsup",
    });
    const elsewhere = structuredClone(
      intakeFixture("message-created.bug.json").payload,
    ) as { event: { channel: string } };
    elsewhere.event.channel = "C0ELSEWHERE";
    expect((await run(elsewhere, ctx)).output).toMatchObject({
      skipped: expect.stringMatching(/not a customer channel/),
    });
  });

  it("stores a human triage-thread message as internal, linked by the thread root", async () => {
    const bug = makeCtx("exec-bug", JEV.bug);
    const { output } = await run(
      intakeFixture("message-created.bug.json").payload,
      bug.ctx,
    );
    const issue = await getIssue(db, output.issueId as string);
    const note = structuredClone(
      intakeFixture("message-created.bug.json").payload,
    ) as { eventId: string; event: Record<string, unknown> };
    note.eventId = "Ev0INTAKENOTE1";
    note.event.channel = "C0TRIAGE001";
    note.event.user = "U0TEAMMATE1";
    note.event.ts = "1790890500.000500";
    note.event.thread_ts = issue.triageRootTs;
    const ctx = makeCtx("exec-note");
    expect((await run(note, ctx.ctx)).output).toMatchObject({
      outcome: "internal",
      issueId: issue.id,
    });
    expect(ctx.emitted).toHaveLength(0);
    expect(ctx.slack("chat.postMessage")).toHaveLength(0);
    const rows = await withDb(ctx.ctx as never, (d) =>
      d.query("select direction from messages where source_event_id = $1", [
        "Ev0INTAKENOTE1",
      ]),
    );
    expect(rows).toEqual([{ direction: "internal" }]);
  });
});
