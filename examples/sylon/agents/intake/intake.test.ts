/** intake on a local trace: real step code, one in-memory database, no Slack, no network. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/index";
import { localFleetDb, setLocalDb, withDb, type Db } from "../../_shared/db";
import { setConfig } from "../../_shared/config";
import {
  accountByChannel,
  createDraft,
  getDraft,
  getIssue,
  linkMessage,
  messageBySourceEventId,
  messagesForIssue,
  openIssue,
} from "../../_shared/issues";
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
import { TITLE_MAX, agent, stripClientFooter, titleOf } from "./index";

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
    const q = questions([cand]);
    expect(
      "linked_issue" in q && Object.keys(q.linked_issue.criteria).sort(),
    ).toEqual(["issue_7", "new"]);
  });

  it("asks no link question when the account has no open issues", () => {
    // A one-option choice is a 400 from the decisions API, which left first messages unclassified.
    expect(questions([])).not.toHaveProperty("linked_issue");
    const { linked_issue: _, ...jev } = JEV.bug;
    expect(decide({ ...base, jev, candidates: [] })).toEqual({
      kind: "open",
      reason: "jev",
    });
  });

  it("drops a trailing client footer from titles and mirrored text", () => {
    const posted =
      "[sylon test] the Pellmark sync is stuck *Sent using* <@U09EXAMPLE1>";
    expect(titleOf(posted)).toBe("[sylon test] the Pellmark sync is stuck");
    expect(stripClientFooter("line one\n*Sent using* <@U1|Claude>\n")).toBe(
      "line one",
    );
    // Only a trailing footer: the same words mid-message stay.
    expect(stripClientFooter("*Sent using* <@U1> is a footer")).toBe(
      "*Sent using* <@U1> is a footer",
    );
  });

  it("strips the footer in linear time on adversarial input", () => {
    const spaces = `a${" ".repeat(100_000)}b`;
    const footers = "*Sent using*<@".repeat(20_000);
    const start = performance.now();
    expect(stripClientFooter(spaces)).toBe(spaces);
    expect(stripClientFooter(footers)).toBe(footers);
    expect(stripClientFooter(`hi${" ".repeat(50_000)}*Sent using* <@U1>`)).toBe(
      "hi",
    );
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("cuts a long title at a word, with an ellipsis", () => {
    const text =
      "Our webhook deliveries started failing this morning. Every POST to our endpoint is rejected";
    const title = titleOf(text);
    expect(title).toBe(
      "Our webhook deliveries started failing this morning. Every POST to our endpoint…",
    );
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(titleOf("short  <!here> one")).toBe("short @here one");
    expect(titleOf("x".repeat(100))).toBe(`${"x".repeat(79)}…`);
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
    // The mirror ends with a link to the customer message.
    expect(mirror.text).toMatch(
      /<https:\/\/slack\.com\/archives\/C0CUSTOMER1\/p1790890000000100\|view>$/,
    );
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

  describe("team vs customer", () => {
    const teamReply = () =>
      intakeFixture("message-created.team-reply.json").payload;

    async function openBug() {
      const { output } = await run(
        intakeFixture("message-created.bug.json").payload,
        makeCtx("exec-bug", JEV.bug).ctx,
      );
      return output.issueId as string;
    }

    it("a team reply in an issue thread is stored as agent, hands the ball to the customer, mirrors once", async () => {
      const issueId = await openBug();
      const issue = await getIssue(db, issueId);
      const draft = await createDraft(db, { issueId, text: "hi" });

      const t = makeCtx("exec-team");
      const out = await run(teamReply(), t.ctx);
      expect(out.visited).toEqual(["guard", "team"]);
      expect(out.output).toMatchObject({
        outcome: "team_reply",
        issueId,
        status: "on_customer",
      });
      expect(t.calls).toHaveLength(0);
      expect(t.emitted).toHaveLength(0);
      expect(t.slack("reactions.add")).toHaveLength(0);
      expect(t.slack("reactions.remove")).toHaveLength(0);
      expect(await getIssue(db, issueId)).toMatchObject({
        status: "on_customer",
      });
      expect((await getDraft(db, draft.id)).status).toBe("superseded");
      const stored = await messageBySourceEventId(db, "Ev0INTAKETEAM1");
      expect(stored).toMatchObject({
        issueId,
        direction: "agent",
        userId: "U0TEAMENG01",
        userName: "U0TEAMENG01",
      });
      expect(t.slack("chat.postMessage")).toEqual([
        expect.objectContaining({
          threadTs: issue.triageRootTs,
          text: expect.stringMatching(
            /^\*U0TEAMENG01\* \(team\): Looking into it/,
          ),
        }),
      ]);
      expect(t.slack("chat.update")).toEqual([
        expect.objectContaining({ ts: issue.triageRootTs }),
      ]);

      // Redelivery: stored once, not mirrored twice.
      const again = makeCtx("exec-team-2");
      expect((await run(teamReply(), again.ctx)).output).toMatchObject({
        outcome: "team_reply",
        duplicate: true,
      });
      expect(again.slack("chat.postMessage")).toHaveLength(0);
      expect(await messagesForIssue(db, issueId)).toHaveLength(2);
    });

    it("leaves On Hold and Closed issues where they are", async () => {
      for (const status of ["on_hold", "closed"]) {
        setLocalDb(undefined);
        db = await localFleetDb();
        setLocalDb(db);
        const issueId = await openBug();
        await db.query("update issues set status = $2 where id = $1", [
          issueId,
          status,
        ]);
        await run(teamReply(), makeCtx("exec-team").ctx);
        expect((await getIssue(db, issueId)).status).toBe(status);
      }
    });

    it("a team message with no issue is stored and does nothing else", async () => {
      const top = structuredClone(teamReply()) as {
        event: { thread_ts?: string };
      };
      delete top.event.thread_ts;
      const t = makeCtx("exec-team-top");
      expect((await run(top, t.ctx)).output).toMatchObject({
        outcome: "team_message",
        issueId: null,
      });
      expect(await messageBySourceEventId(db, "Ev0INTAKETEAM1")).toMatchObject({
        issueId: null,
        direction: "agent",
      });
      expect(t.calls).toHaveLength(0);
      expect(t.emitted).toHaveLength(0);
      expect(t.slack("chat.postMessage")).toHaveLength(0);
      expect(t.slack("reactions.add")).toHaveLength(0);
      expect(await getAccountIssues()).toBe(0);
    });

    const getAccountIssues = async () =>
      Number(
        (
          await db.query<{ n: string }>(
            "select count(*)::text as n from issues",
          )
        )[0].n,
      );

    it("a customer message from another workspace takes the normal flow", async () => {
      const t = makeCtx("exec-cnx", JEV.bug);
      const out = await run(
        intakeFixture("message-created.connect-customer.json").payload,
        t.ctx,
      );
      expect(out.output).toMatchObject({ outcome: "opened" });
      expect(t.slack("reactions.add").map((r) => r.name)).toEqual([
        "eyes",
        "ticket",
      ]);
    });

    it("a listed test user is the customer even from our workspace", async () => {
      await setConfig(db, "customers.test_user_ids", ["U0TEAMENG01"], "test");
      const top = structuredClone(teamReply()) as {
        event: { thread_ts?: string };
      };
      delete top.event.thread_ts;
      const out = await run(top, makeCtx("exec-test-user", JEV.bug).ctx);
      expect(out.output).toMatchObject({ outcome: "opened" });
    });

    it("intake.reactions=false adds and removes no reactions", async () => {
      await setConfig(db, "intake.reactions", false, "test");
      const t = makeCtx("exec-quiet", JEV.bug);
      const out = await run(
        intakeFixture("message-created.bug.json").payload,
        t.ctx,
      );
      expect(out.output).toMatchObject({ outcome: "opened" });
      expect(t.slack("reactions.add")).toHaveLength(0);
      expect(t.slack("reactions.remove")).toHaveLength(0);
      expect(t.emitted).toHaveLength(1);
    });
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
  it("links a reply in a thread that Jev cross-linked to an existing issue, without Jev", async () => {
    const bug = makeCtx("exec-bug", JEV.bug);
    const { output } = await run(
      intakeFixture("message-created.bug.json").payload,
      bug.ctx,
    );
    const issueId = output.issueId as string;
    // A new top-level message that Jev links to #1: its thread is not the issue's customer thread.
    const other = structuredClone(
      intakeFixture("message-created.thank-you.json").payload,
    ) as { eventId: string; event: { ts: string; text: string } };
    other.eventId = "Ev0INTAKEXLNK1";
    other.event.ts = "1790890600.000600";
    other.event.text = "Same export problem from another team, export 4412.";
    const xl = makeCtx("exec-xlink", asJev(0.9, "issue_1", 0.95));
    expect((await run(other, xl.ctx)).output).toMatchObject({
      outcome: "linked",
      issueId,
    });
    // A reply in that second thread links through the stored root message; Jev is never asked.
    const reply = structuredClone(other) as typeof other & {
      event: { thread_ts?: string };
    };
    reply.eventId = "Ev0INTAKEXLNK2";
    reply.event.ts = "1790890700.000700";
    reply.event.thread_ts = "1790890600.000600";
    reply.event.text = "Any news?";
    const r = makeCtx("exec-xlink-reply");
    expect((await run(reply, r.ctx)).output).toMatchObject({
      outcome: "linked",
      issueId,
    });
    expect(r.calls).toHaveLength(0);
    expect(await messagesForIssue(db, issueId)).toHaveLength(3);
  });

  it("a retry after an interrupted link reapplies the status move", async () => {
    const bug = makeCtx("exec-bug", JEV.bug);
    const { output } = await run(
      intakeFixture("message-created.bug.json").payload,
      bug.ctx,
    );
    const issueId = output.issueId as string;
    // The first attempt stored and linked the follow-up, then died before setStatus.
    const fup = intakeFixture("message-created.follow-up.json").payload as {
      eventId: string;
      event: { ts: string; thread_ts: string; user: string; text: string };
    };
    await linkMessage(db, {
      issueId,
      source: "slack",
      sourceEventId: fup.eventId,
      direction: "customer",
      slack: {
        channel: "C0CUSTOMER1",
        ts: fup.event.ts,
        threadTs: fup.event.thread_ts,
      },
      userId: fup.event.user,
      text: fup.event.text,
    });
    expect((await getIssue(db, issueId)).status).toBe("new");
    const retry = makeCtx("exec-fup-retry");
    expect((await run(fup, retry.ctx)).output).toMatchObject({
      outcome: "linked",
      issueId,
    });
    expect((await getIssue(db, issueId)).status).toBe("on_you");
    expect(retry.slack("chat.update")).toHaveLength(1);
    // The mirror went out (or not) with the first attempt; a replay never posts it again.
    expect(retry.slack("chat.postMessage")).toHaveLength(0);
  });

  it("a redelivered follow-up does not reopen an issue closed since", async () => {
    const bug = makeCtx("exec-bug", JEV.bug);
    const { output } = await run(
      intakeFixture("message-created.bug.json").payload,
      bug.ctx,
    );
    const issueId = output.issueId as string;
    const fup = intakeFixture("message-created.follow-up.json").payload;
    await run(fup, makeCtx("exec-fup").ctx);
    expect((await getIssue(db, issueId)).status).toBe("on_you");
    const close = structuredClone(
      fixture("slack/block-actions.issue-close.json").payload,
    ) as { actions: { value: string }[] };
    close.actions[0].value = issueId;
    await run(close, makeCtx("exec-close").ctx);
    // Slack redelivers the follow-up: its issue.message_added is logged, so the move already ran.
    const again = makeCtx("exec-fup-again");
    expect((await run(fup, again.ctx)).output).toMatchObject({
      outcome: "linked",
      issueId,
    });
    expect((await getIssue(db, issueId)).status).toBe("closed");
    expect(again.slack("chat.postMessage")).toHaveLength(0);
  });

  it("overlapping announce runs for one issue post exactly one card", async () => {
    const account = (await accountByChannel(db, "C0CUSTOMER1"))!;
    const issue = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "high",
      title: "Race",
      customer: { channel: "C0CUSTOMER1", ts: "1790891000.000100" },
    });
    const announce = (agent.steps as unknown as Record<string, StepDef>)
      .announce;
    const input = {
      incoming: {
        eventId: "Ev0INTAKERACE1",
        trigger: "message",
        channel: "C0CUSTOMER1",
        ts: "1790891000.000100",
      },
      userName: "customer",
      text: "Race",
      accountId: account.id,
      decision: "open",
      issueId: issue.id,
      messageId: "00000000-0000-4000-8000-000000000001",
      created: true,
      duplicate: false,
    };
    const a = makeCtx("exec-race-a");
    const b = makeCtx("exec-race-b");
    await Promise.all([announce.run(input, a.ctx), announce.run(input, b.ctx)]);
    const cards = [
      ...a.slack("chat.postMessage"),
      ...b.slack("chat.postMessage"),
    ].filter((p) => !p.threadTs);
    expect(cards).toHaveLength(1);
    expect((await getIssue(db, issue.id)).triageRootTs).toBeTruthy();
  });

  it("ignores an issue.* click from outside the triage channel, before any write", async () => {
    const bug = makeCtx("exec-bug", JEV.bug);
    const { output } = await run(
      intakeFixture("message-created.bug.json").payload,
      bug.ctx,
    );
    const close = structuredClone(
      fixture("slack/block-actions.issue-close.json").payload,
    ) as {
      actions: { value: string }[];
      container: { channel_id: string };
      channel: { id: string };
    };
    close.actions[0].value = output.issueId as string;
    close.container.channel_id = "C0CUSTOMER1";
    close.channel.id = "C0CUSTOMER1";
    const c = makeCtx("exec-close-foreign");
    expect((await run(close, c.ctx)).output).toEqual({
      skipped: "issue action from channel C0CUSTOMER1, not triage",
    });
    expect((await getIssue(db, output.issueId as string)).status).toBe("new");
    expect(c.slack("chat.update")).toHaveLength(0);
    expect(c.slack("chat.postMessage")).toHaveLength(0);
    const runs = await db.query("select 1 from runs where execution_id = $1", [
      "exec-close-foreign",
    ]);
    expect(runs).toHaveLength(0);
  });

  it("two overlapping Close clicks post one Closed by", async () => {
    const bug = makeCtx("exec-bug", JEV.bug);
    const { output } = await run(
      intakeFixture("message-created.bug.json").payload,
      bug.ctx,
    );
    const close = structuredClone(
      fixture("slack/block-actions.issue-close.json").payload,
    ) as { actions: { value: string }[] };
    close.actions[0].value = output.issueId as string;
    const a = makeCtx("exec-close-a");
    const b = makeCtx("exec-close-b");
    const outs = await Promise.all([run(close, a.ctx), run(close, b.ctx)]);
    expect(outs.map((o) => o.output.changed).sort()).toEqual([false, true]);
    const closedBy = [
      ...a.slack("chat.postMessage"),
      ...b.slack("chat.postMessage"),
    ].filter((p) => String(p.text).startsWith("Closed by"));
    expect(closedBy).toHaveLength(1);
  });
});
