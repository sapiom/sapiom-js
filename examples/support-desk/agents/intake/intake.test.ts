/** intake on a local trace: real step code, one in-memory database, no Slack, no network. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixture } from "../../fixtures/index";
import {
  localFleetDb,
  resetSharedDb,
  setLocalDb,
  withDb,
  type Db,
} from "../../_shared/db";
import { setConfig } from "../../_shared/config";
import { upsertDesk } from "../../_shared/desks";
import {
  accountByChannel,
  createDraft,
  getDraft,
  getIssue,
  linkMessage,
  messageBySourceEventId,
  messagesForIssue,
  openIssue,
  setStatus,
  updateIssue,
  type Issue,
} from "../../_shared/issues";
import { EXAMPLE_SLA, fakeCtx } from "../../_shared/test-ctx";
import {
  decide,
  IS_ISSUE_MIN,
  LINK_MIN,
  optionKey,
  questions,
  type Candidate,
  type IntakeJev,
} from "./decide";
import {
  TITLE_MAX,
  agent,
  noteOpenLinear,
  stripClientFooter,
  titleOf,
} from "./index";

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
      "[test] the Pellmark sync is stuck *Sent using* <@U09EXAMPLE1>";
    expect(titleOf(posted)).toBe("[test] the Pellmark sync is stuck");
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
    // A follow-up redraws the card and posts nothing: no copy of the message in the triage thread.
    expect(fup.slack("chat.postMessage")).toEqual([]);
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

  it("Close on an escalated issue notes its open Linear ticket once, in the triage thread and on Linear", async () => {
    const { output } = await run(
      intakeFixture("message-created.bug.json").payload,
      makeCtx("exec-bug", JEV.bug).ctx,
    );
    const issueId = output.issueId as string;
    await updateIssue(db, issueId, {
      linearIssueId: "uuid-SAP-9",
      linearIdentifier: "SAP-9",
      linearUrl: "https://linear.app/x/issue/SAP-9",
    });
    await setStatus(db, issueId, "on_hold");
    const issue = await getIssue(db, issueId);

    const close = structuredClone(
      fixture("slack/block-actions.issue-close.json").payload,
    ) as { actions: { value: string }[] };
    close.actions[0].value = issueId;
    const c = makeCtx("exec-close-linked");
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
      expect.objectContaining({
        threadTs: issue.triageRootTs,
        text: "<https://linear.app/x/issue/SAP-9|SAP-9> is still open in Linear. Cancel it there if it no longer needs work.",
      }),
    ]);
    expect(c.logs.map((l) => l.msg)).toContain(
      "linear save_comment (local trace, not sent)",
    );

    const c2 = makeCtx("exec-close-linked-2");
    expect((await run(close, c2.ctx)).output).toMatchObject({ changed: false });
    expect(c2.slack("chat.postMessage")).toHaveLength(0);
    expect(c2.logs.some((l) => l.msg.startsWith("linear "))).toBe(false);
  });

  it("with sla set, the first card shows the first-response deadline", async () => {
    await setConfig(db, "sla", EXAMPLE_SLA, "test");
    const bug = makeCtx("exec-sla", JEV.bug);
    await run(intakeFixture("message-created.bug.json").payload, bug.ctx);
    const card = bug.slack("chat.postMessage").find((p) => !p.threadTs)!;
    expect(JSON.stringify(card.blocks)).toContain(
      "*First response due:* <!date^",
    );
    // A follow-up redraws the card through refreshCard, still before any team reply.
    const fup = makeCtx("exec-sla-fup");
    await run(intakeFixture("message-created.follow-up.json").payload, fup.ctx);
    const [redrawn] = fup.slack("chat.update");
    expect(JSON.stringify(redrawn.blocks)).toContain(
      "*First response due:* <!date^",
    );
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

    it("a team reply in an issue thread is stored as agent, hands the ball to the customer, posts nothing", async () => {
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
      expect(t.slack("chat.postMessage")).toEqual([]);
      expect(t.slack("chat.update")).toEqual([
        expect.objectContaining({ ts: issue.triageRootTs }),
      ]);

      // Redelivery: stored once.
      const again = makeCtx("exec-team-2");
      expect((await run(teamReply(), again.ctx)).output).toMatchObject({
        outcome: "team_reply",
        duplicate: true,
      });
      expect(again.slack("chat.postMessage")).toHaveLength(0);
      expect(await messagesForIssue(db, issueId)).toHaveLength(2);
    });

    it("a team reply makes the poster the owner of an unowned issue", async () => {
      const issueId = await openBug();
      expect((await getIssue(db, issueId)).ownerSlackId).toBeNull();
      await run(teamReply(), makeCtx("exec-team").ctx);
      expect((await getIssue(db, issueId)).ownerSlackId).toBe("U0TEAMENG01");
    });

    it("a team reply whose run fails before the move commits is applied in full by the retry", async () => {
      const issueId = await openBug();
      // Fails the owner update once, after the reply row was written in the same transaction.
      let failed = false;
      const flaky = (inner: Db): Db => ({
        ...inner,
        async query(text, params) {
          if (!failed && text.includes("set owner_slack_id")) {
            failed = true;
            throw new Error("connection reset");
          }
          return inner.query(text, params);
        },
        transaction: (fn) => inner.transaction((tx) => fn(flaky(tx))),
      });
      setLocalDb(flaky(db));
      await expect(run(teamReply(), makeCtx("exec-team").ctx)).rejects.toThrow(
        "connection reset",
      );
      expect(await messageBySourceEventId(db, "Ev0INTAKETEAM1")).toBeNull();

      const retry = makeCtx("exec-team-retry");
      expect((await run(teamReply(), retry.ctx)).output).toMatchObject({
        outcome: "team_reply",
        duplicate: false,
        status: "on_customer",
      });
      expect(await getIssue(db, issueId)).toMatchObject({
        status: "on_customer",
        ownerSlackId: "U0TEAMENG01",
      });
      expect(retry.slack("chat.update")).toHaveLength(1);
      setLocalDb(db);
    });

    it("a team reply keeps an existing owner", async () => {
      const issueId = await openBug();
      await db.query("update issues set owner_slack_id = $2 where id = $1", [
        issueId,
        "U0TEAMMATE1",
      ]);
      await run(teamReply(), makeCtx("exec-team").ctx);
      expect((await getIssue(db, issueId)).ownerSlackId).toBe("U0TEAMMATE1");
    });

    it("a team reply with a screenshot (file_share) is the team's answer", async () => {
      const issueId = await openBug();
      const reply = structuredClone(teamReply()) as {
        event: Record<string, unknown>;
      };
      reply.event.subtype = "file_share";
      reply.event.text = "";
      reply.event.files = [{ id: "F0SHOT", name: "image.png" }];
      const t = makeCtx("exec-team-file");
      expect((await run(reply, t.ctx)).output).toMatchObject({
        outcome: "team_reply",
        issueId,
        status: "on_customer",
      });
      expect(await messageBySourceEventId(db, "Ev0INTAKETEAM1")).toMatchObject({
        direction: "agent",
        text: "(attached image.png)",
      });
      expect(t.slack("chat.postMessage")).toEqual([]);
    });

    it("an edit, a delete or a thread broadcast is still skipped", async () => {
      await openBug();
      for (const subtype of [
        "message_changed",
        "message_deleted",
        "thread_broadcast",
      ]) {
        const edit = structuredClone(teamReply()) as {
          event: Record<string, unknown>;
        };
        edit.event.subtype = subtype;
        expect(
          (await run(edit, makeCtx(`exec-${subtype}`).ctx)).output,
        ).toEqual({
          skipped: "bot or edited message",
        });
      }
      expect(await messageBySourceEventId(db, "Ev0INTAKETEAM1")).toBeNull();
    });

    it("a redelivered team reply after a newer customer follow-up changes nothing", async () => {
      const issueId = await openBug();
      await run(teamReply(), makeCtx("exec-team").ctx);
      const fup = structuredClone(
        intakeFixture("message-created.follow-up.json").payload,
      ) as { eventId: string; event: { ts: string; event_ts: string } };
      fup.eventId = "Ev0INTAKEFUP2";
      fup.event.ts = fup.event.event_ts = "1790890400.000500";
      await run(fup, makeCtx("exec-fup").ctx);
      const draft = await createDraft(db, { issueId, text: "answer" });
      expect((await getIssue(db, issueId)).status).toBe("on_you");

      const again = makeCtx("exec-team-again");
      expect((await run(teamReply(), again.ctx)).output).toMatchObject({
        outcome: "team_reply",
        duplicate: true,
        status: "on_you",
      });
      expect((await getIssue(db, issueId)).status).toBe("on_you");
      expect((await getDraft(db, draft.id)).status).toBe("pending");
    });

    it("a team reply older than the customer's latest message changes nothing", async () => {
      const issueId = await openBug();
      await run(
        intakeFixture("message-created.follow-up.json").payload,
        makeCtx("exec-fup").ctx,
      );
      const draft = await createDraft(db, { issueId, text: "answer" });
      const old = structuredClone(teamReply()) as {
        eventId: string;
        event: { ts: string; event_ts: string };
      };
      old.eventId = "Ev0INTAKETEAMOLD";
      old.event.ts = old.event.event_ts = "1790890050.000300";
      const out = await run(old, makeCtx("exec-team-old").ctx);
      expect(out.output).toMatchObject({
        outcome: "team_reply",
        duplicate: false,
        status: "on_you",
      });
      expect((await getIssue(db, issueId)).status).toBe("on_you");
      expect((await getDraft(db, draft.id)).status).toBe("pending");
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

    it("an outsider in an unlisted channel opens an issue and creates its account", async () => {
      const msg = structuredClone(
        intakeFixture("message-created.bug.json").payload,
      ) as { event: { channel: string } };
      msg.event.channel = "C0UNLISTED1";
      expect(await accountByChannel(db, "C0UNLISTED1")).toBeNull();
      const out = await run(msg, makeCtx("exec-unlisted", JEV.bug).ctx);
      expect(out.output).toMatchObject({ outcome: "opened" });
      expect(await accountByChannel(db, "C0UNLISTED1")).toMatchObject({
        name: "C0UNLISTED1",
      });
    });

    it("a team message in a channel with no account is skipped and stores nothing", async () => {
      const msg = structuredClone(teamReply()) as {
        event: { channel: string; thread_ts?: string };
      };
      msg.event.channel = "C0INTERNAL01";
      delete msg.event.thread_ts;
      const t = makeCtx("exec-internal-chat");
      const out = await run(msg, t.ctx);
      expect(out).toMatchObject({
        visited: ["guard"],
        output: { skipped: "team message outside a customer channel" },
      });
      expect(await messageBySourceEventId(db, "Ev0INTAKETEAM1")).toBeNull();
      expect(t.slack("reactions.add")).toHaveLength(0);
    });

    it("a team message in a channel that has an account takes the team step", async () => {
      const msg = structuredClone(
        intakeFixture("message-created.connect-customer.json").payload,
      ) as { event: { channel: string; user: string; user_team: string } };
      msg.event.channel = "C0UNLISTED1";
      await run(msg, makeCtx("exec-cnx", JEV.bug).ctx);
      const chat = structuredClone(teamReply()) as {
        event: { channel: string; thread_ts?: string };
      };
      chat.event.channel = "C0UNLISTED1";
      delete chat.event.thread_ts;
      const out = await run(chat, makeCtx("exec-team-acct").ctx);
      expect(out.visited).toEqual(["guard", "team"]);
      expect(out.output).toMatchObject({ outcome: "team_message" });
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
    const ticket = structuredClone(
      intakeFixture("reaction-added.ticket.json").payload,
    ) as { event: { item: { channel: string } } };
    ticket.event.item.channel = "C0ELSEWHERE";
    expect((await run(ticket, ctx)).output).toMatchObject({
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

  const NUDGE_BLOCKS = [
    {
      type: "section",
      block_id: "nudge.stale",
      text: { type: "mrkdwn", text: "Stale" },
    },
    {
      type: "actions",
      block_id: "nudge.actions",
      elements: [{ type: "button", action_id: "issue.take" }],
    },
  ];

  it("Take from a nudge shows Taking, refreshes the card, then redraws the nudge as Taken by", async () => {
    const bug = makeCtx("exec-bug", JEV.bug);
    const { output } = await run(
      intakeFixture("message-created.bug.json").payload,
      bug.ctx,
    );
    const issue = await getIssue(db, output.issueId as string);
    const take = structuredClone(
      fixture("slack/block-actions.issue-take.json").payload,
    ) as {
      actions: { value: string; block_id: string }[];
      container: { message_ts: string };
      message: { blocks: unknown[] };
    };
    take.actions[0].value = issue.id;
    take.actions[0].block_id = "nudge.actions";
    take.container.message_ts = "1790899999.000999";
    take.message.blocks = structuredClone(NUDGE_BLOCKS);
    const t = makeCtx("exec-take-nudge");
    expect((await run(take, t.ctx)).output).toMatchObject({ changed: true });
    const updates = t.slack("chat.update");
    expect(updates.map((u) => u.ts)).toEqual([
      "1790899999.000999",
      issue.triageRootTs,
      "1790899999.000999",
    ]);
    expect(JSON.stringify(updates[0].blocks)).toContain("Taking…");
    const final = JSON.stringify(updates[2].blocks);
    expect(final).toContain("Taken by <@U0TEAMMATE1>");
    expect(final).not.toContain("Taking");
    expect(final).not.toContain("issue.take");

    const t2 = makeCtx("exec-take-nudge-2");
    await run(take, t2.ctx);
    expect(JSON.stringify(t2.slack("chat.update").at(-1)!.blocks)).toContain(
      "Owned by <@U0TEAMMATE1>",
    );
  });

  it("shows no working card for an issue click whose value is not an id", async () => {
    const take = structuredClone(
      fixture("slack/block-actions.issue-take.json").payload,
    ) as { actions: { value: string }[]; message: { blocks: unknown[] } };
    take.actions[0].value = "nope";
    take.message.blocks = structuredClone(NUDGE_BLOCKS);
    const t = makeCtx("exec-take-bad");
    expect((await run(take, t.ctx)).output).toMatchObject({
      skipped: expect.stringContaining("no issue id"),
    });
    expect(t.slack("chat.update")).toHaveLength(0);
  });

  it("restores the clicked card when the issue is not found", async () => {
    const take = structuredClone(
      fixture("slack/block-actions.issue-take.json").payload,
    ) as {
      actions: { value: string; block_id: string }[];
      message: { blocks: unknown[] };
    };
    take.actions[0].value = "00000000-0000-4000-8000-000000000000";
    take.actions[0].block_id = "nudge.actions";
    take.message.blocks = structuredClone(NUDGE_BLOCKS);
    const t = makeCtx("exec-take-missing");
    expect((await run(take, t.ctx)).output).toMatchObject({
      skipped: expect.stringContaining("not found"),
    });
    const updates = t.slack("chat.update");
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates[0].blocks)).toContain("Taking…");
    expect(updates[1]).toMatchObject({ blocks: NUDGE_BLOCKS });
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

  describe("timers and Resolved", () => {
    async function openedBug() {
      const { output } = await run(
        intakeFixture("message-created.bug.json").payload,
        makeCtx("exec-bug", JEV.bug).ctx,
      );
      return output.issueId as string;
    }
    function click(verb: string, issueId: string) {
      const c = structuredClone(
        fixture("slack/block-actions.issue-close.json").payload,
      ) as { actions: { action_id: string; value: string }[] };
      c.actions[0].action_id = `issue.${verb}`;
      c.actions[0].value = issueId;
      return c;
    }
    async function escalated(issueId: string) {
      await updateIssue(db, issueId, {
        linearIssueId: "uuid-SAP-7",
        linearIdentifier: "SAP-7",
        linearUrl: "https://linear.app/x/issue/SAP-7",
      });
      await setStatus(db, issueId, "on_hold");
    }

    it("a new ticket gets a timer and Close clears it", async () => {
      const issueId = await openedBug();
      expect((await getIssue(db, issueId)).nextTickId).toMatch(/^local:/);
      await run(click("close", issueId), makeCtx("exec-close").ctx);
      expect(await getIssue(db, issueId)).toMatchObject({
        status: "closed",
        nextTickId: null,
        nextTickAt: null,
      });
    });

    it("Resolved moves an On Hold ticket On You, posts who resolved it, and a second click does nothing", async () => {
      const issueId = await openedBug();
      await escalated(issueId);
      const c = makeCtx("exec-resolve");
      const out = await run(click("resolve", issueId), c.ctx);
      expect(out.output).toMatchObject({
        outcome: "resolve",
        changed: true,
        status: "on_you",
      });
      expect(c.slack("chat.postMessage")).toEqual([
        expect.objectContaining({
          channel: "C0TRIAGE001",
          text: "Marked resolved by <@U0TEAMMATE1> (<https://linear.app/x/issue/SAP-7|SAP-7>). Reply to the customer.",
        }),
      ]);
      expect(c.emitted.map((e) => e.type)).toEqual([
        "issue.engineering_resolved",
      ]);
      // The card is redrawn without the Resolved button.
      const card = c.slack("chat.update").at(-1)!;
      expect(JSON.stringify(card.blocks)).not.toContain("issue.resolve");
      expect((await getIssue(db, issueId)).cardDirty).toBe(false);

      const again = makeCtx("exec-resolve-2");
      expect(
        (await run(click("resolve", issueId), again.ctx)).output,
      ).toMatchObject({ changed: false, status: "on_you" });
      expect(again.slack("chat.postMessage")).toEqual([]);
      expect(again.emitted).toEqual([]);
    });

    it("a customer message on an On Hold ticket reads its Linear issue", async () => {
      const issueId = await openedBug();
      await escalated(issueId);
      const fup = makeCtx("exec-fup");
      await run(
        intakeFixture("message-created.follow-up.json").payload,
        fup.ctx,
      );
      expect(
        fup.logs.filter((l) => l.msg.startsWith("linear get_issue")),
      ).toHaveLength(1);
      // The local trace's Linear stub answers Todo: the ticket stays On Hold, the read is stamped.
      expect(await getIssue(db, issueId)).toMatchObject({
        status: "on_hold",
        linearState: "Todo",
      });
      expect((await getIssue(db, issueId)).linearCheckedAt).not.toBeNull();
    });
  });

  describe("desks", () => {
    const bugIn = (channel: string, eventId = "Ev0DESKBUG1") => {
      const p = structuredClone(
        intakeFixture("message-created.bug.json").payload,
      ) as { eventId: string; event: Record<string, unknown> };
      p.eventId = eventId;
      p.event.channel = channel;
      return p;
    };
    const addTestDesk = () =>
      upsertDesk(db, {
        slug: "test",
        name: "Test",
        triageChannel: "C0TESTTRI01",
      });

    it("files a listed channel under its desk and cards in that desk's triage channel", async () => {
      const test = (await addTestDesk()).desk;
      await setConfig(
        db,
        "channels.customer",
        [
          { channelId: "C0CUSTOMER1", accountName: "Example" },
          { channelId: "C0TESTCUST1", accountName: "Test co", desk: "test" },
        ],
        "t",
      );
      const c = makeCtx("exec-desk-listed", JEV.bug);
      const { output } = await run(bugIn("C0TESTCUST1"), c.ctx);
      expect(output).toMatchObject({ outcome: "opened" });
      const issue = await getIssue(db, output.issueId as string);
      expect(issue.deskId).toBe(test.id);
      expect((await accountByChannel(db, "C0TESTCUST1"))?.deskId).toBe(test.id);
      const posts = c.slack("chat.postMessage");
      expect(posts).toHaveLength(2);
      expect(posts.every((p) => p.channel === "C0TESTTRI01")).toBe(true);
    });

    it("files an unlisted channel under the default desk", async () => {
      await addTestDesk();
      const c = makeCtx("exec-desk-default", JEV.bug);
      const { output } = await run(bugIn("C0RANDOM01"), c.ctx);
      const issue = await getIssue(db, output.issueId as string);
      const support = (
        await db.query<{ id: string }>(
          "select id from desks where slug = 'support'",
        )
      )[0];
      expect(issue.deskId).toBe(support.id);
      expect(
        c.slack("chat.postMessage").every((p) => p.channel === "C0TRIAGE001"),
      ).toBe(true);
    });

    it("skips a channel that has no desk: an unknown slug, or no default desk", async () => {
      await setConfig(
        db,
        "channels.customer",
        [{ channelId: "C0TYPO0001", accountName: "Typo", desk: "nope" }],
        "t",
      );
      const typo = makeCtx("exec-desk-typo");
      expect((await run(bugIn("C0TYPO0001"), typo.ctx)).output).toMatchObject({
        outcome: "no desk for channel",
        issueId: null,
      });

      await upsertDesk(
        db,
        {
          slug: "support",
          name: "Support",
          triageChannel: "C0TRIAGE001",
          isDefault: false,
        },
        { overwrite: true },
      );
      const none = makeCtx("exec-desk-none");
      expect(
        (await run(bugIn("C0RANDOM01", "Ev0DESKBUG2"), none.ctx)).output,
      ).toMatchObject({ outcome: "no desk for channel" });
      for (const c of [typo, none]) {
        expect(c.slack("chat.postMessage")).toHaveLength(0);
        expect(c.emitted).toHaveLength(0);
      }
      expect(await db.query("select 1 from issues")).toHaveLength(0);
      expect(await accountByChannel(db, "C0RANDOM01")).toBeNull();
    });

    it("ignores a click from another desk's triage channel, before any write", async () => {
      await addTestDesk();
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
      close.container.channel_id = "C0TESTTRI01";
      close.channel.id = "C0TESTTRI01";
      const c = makeCtx("exec-close-other-desk");
      expect((await run(close, c.ctx)).output).toEqual({
        skipped: `issue ${output.issueId} belongs to desk support, not test`,
      });
      expect((await getIssue(db, output.issueId as string)).status).toBe("new");
      expect(c.slack("chat.postMessage")).toHaveLength(0);

      // From its own desk's channel the same click closes it.
      close.container.channel_id = "C0TRIAGE001";
      close.channel.id = "C0TRIAGE001";
      const own = makeCtx("exec-close-own-desk");
      expect((await run(close, own.ctx)).output).toMatchObject({
        outcome: "close",
        changed: true,
      });
    });

    describe("after the desk's triage channel moves", () => {
      const moveSupport = () =>
        upsertDesk(
          db,
          {
            slug: "support",
            name: "Support",
            triageChannel: "C0NEW",
            isDefault: true,
          },
          { overwrite: true },
        );
      async function cardedThenMoved() {
        const { output } = await run(
          intakeFixture("message-created.bug.json").payload,
          makeCtx("exec-bug", JEV.bug).ctx,
        );
        const issue = await getIssue(db, output.issueId as string);
        expect(issue.triageChannel).toBe("C0TRIAGE001");
        await moveSupport();
        return issue;
      }
      const channels = (c: ReturnType<typeof makeCtx>) => [
        ...c.slack("chat.postMessage").map((p) => p.channel),
        ...c.slack("chat.update").map((p) => p.channel),
      ];
      const closeIn = (issueId: string, channel: string) => {
        const close = structuredClone(
          fixture("slack/block-actions.issue-close.json").payload,
        ) as {
          actions: { value: string }[];
          container: { channel_id: string };
          channel: { id: string };
        };
        close.actions[0].value = issueId;
        close.container.channel_id = channel;
        close.channel.id = channel;
        return close;
      };

      it("a follow-up refreshes the card in the card's channel", async () => {
        const issue = await cardedThenMoved();
        const fup = makeCtx("exec-fup-moved");
        expect(
          (
            await run(
              intakeFixture("message-created.follow-up.json").payload,
              fup.ctx,
            )
          ).output,
        ).toMatchObject({ outcome: "linked", issueId: issue.id });
        expect(fup.slack("chat.update")).toEqual([
          expect.objectContaining({ ts: issue.triageRootTs }),
        ]);
        expect(fup.slack("chat.postMessage")).toHaveLength(0);
        expect(channels(fup)).toEqual(["C0TRIAGE001"]);
      });

      it("a team reply refreshes the card in the card's channel", async () => {
        const issue = await cardedThenMoved();
        const t = makeCtx("exec-team-moved");
        expect(
          (
            await run(
              intakeFixture("message-created.team-reply.json").payload,
              t.ctx,
            )
          ).output,
        ).toMatchObject({ outcome: "team_reply", issueId: issue.id });
        expect(t.slack("chat.postMessage")).toHaveLength(0);
        expect(channels(t)).toEqual(["C0TRIAGE001"]);
      });

      it("Close clicked on the card closes the issue and posts Closed by under it", async () => {
        const issue = await cardedThenMoved();
        await addTestDesk();
        const other = makeCtx("exec-close-moved-other");
        expect(
          (await run(closeIn(issue.id, "C0TESTTRI01"), other.ctx)).output,
        ).toEqual({
          skipped: `issue ${issue.id} belongs to desk support, not test`,
        });

        const c = makeCtx("exec-close-moved");
        expect(
          (await run(closeIn(issue.id, "C0TRIAGE001"), c.ctx)).output,
        ).toMatchObject({ outcome: "close", changed: true });
        expect((await getIssue(db, issue.id)).status).toBe("closed");
        expect(c.slack("chat.postMessage")).toEqual([
          expect.objectContaining({
            channel: "C0TRIAGE001",
            threadTs: issue.triageRootTs,
            text: expect.stringMatching(/^Closed by/),
          }),
        ]);
        expect(channels(c)).not.toContain("C0NEW");
      });

      it("a card without a stored channel is addressed in its desk's current channel", async () => {
        const issue = await cardedThenMoved();
        await db.query(
          "update issues set triage_channel = null where id = $1",
          [issue.id],
        );
        const fup = makeCtx("exec-fup-fallback");
        await run(
          intakeFixture("message-created.follow-up.json").payload,
          fup.ctx,
        );
        expect(fup.slack("chat.update")).toEqual([
          expect.objectContaining({
            channel: "C0NEW",
            ts: issue.triageRootTs,
          }),
        ]);
      });
    });

    it("stores a message from another desk's triage channel without attaching it to the issue", async () => {
      await addTestDesk();
      const bug = makeCtx("exec-bug", JEV.bug);
      const { output } = await run(
        intakeFixture("message-created.bug.json").payload,
        bug.ctx,
      );
      const issue = await getIssue(db, output.issueId as string);
      const note = bugIn("C0TESTTRI01", "Ev0DESKNOTE1") as {
        event: Record<string, unknown>;
      };
      note.event.user = "U0TEAMMATE1";
      note.event.ts = "1790890500.000500";
      note.event.thread_ts = issue.triageRootTs;
      const c = makeCtx("exec-note-other-desk");
      expect((await run(note, c.ctx)).output).toMatchObject({
        outcome: "internal",
        issueId: null,
      });
      // The issue's own desk channel still attaches it.
      const own = bugIn("C0TRIAGE001", "Ev0DESKNOTE2") as {
        event: Record<string, unknown>;
      };
      own.event.user = "U0TEAMMATE1";
      own.event.ts = "1790890500.000600";
      own.event.thread_ts = issue.triageRootTs;
      expect(
        (await run(own, makeCtx("exec-note-own-desk").ctx)).output,
      ).toMatchObject({ outcome: "internal", issueId: issue.id });
    });
  });
});

describe("noteOpenLinear against the relay (mocked fetch)", () => {
  let state: { status: string; statusType: string } | null;
  let failComment: boolean;
  let failMethod: string | null;
  let calls: { tool?: string; method: string; args: Record<string, unknown> }[];

  const issue = {
    id: "11111111-1111-4111-8111-111111111111",
    number: 41,
    linearIssueId: "uuid-SAP-9",
    linearIdentifier: "SAP-9",
    linearUrl: "https://linear.app/x/issue/SAP-9",
    triageRootTs: "1790889356.001",
  } as Issue;

  const rpc = (id: unknown, result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));

  beforeEach(() => {
    vi.stubEnv("SAPIOM_API_KEY", "sat_test");
    state = { status: "In Progress", statusType: "started" };
    failComment = false;
    failMethod = null;
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (url.includes("/connectors/v1/linear/mcp")) {
          const name = body.params.name as string;
          calls.push({
            tool: name,
            method: "mcp",
            args: body.params.arguments,
          });
          const fail =
            (name === "get_issue" && !state) ||
            (name === "save_comment" && failComment);
          if (fail)
            return rpc(body.id, {
              isError: true,
              content: [{ type: "text", text: "Entity not found" }],
            });
          const out =
            name === "get_issue"
              ? {
                  id: "SAP-9",
                  uuid: "uuid-SAP-9",
                  url: "https://linear.app/x/issue/SAP-9",
                  ...state,
                }
              : { id: "comment-1" };
          return rpc(body.id, {
            content: [{ type: "text", text: JSON.stringify(out) }],
          });
        }
        const method = url.split("/methods/")[1];
        calls.push({ method, args: body });
        if (method === failMethod)
          return new Response(JSON.stringify({ ok: false, error: "boom" }), {
            status: 500,
          });
        return new Response(
          JSON.stringify({ channel: body.channel, ts: "1790900000.001" }),
        );
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const posts = () => calls.filter((c) => c.method === "chat.postMessage");
  const comments = () => calls.filter((c) => c.tool === "save_comment");
  const note = async (target: Issue = issue) => {
    const made = fakeCtx({ isLocalTrace: false });
    await noteOpenLinear(made.ctx as never, "C0TRIAGE001", target);
    return made.logs.filter((l) => l.level === "warn").map((l) => l.msg);
  };

  it.each(["completed", "canceled"])(
    "a %s ticket gets no note and no comment",
    async (statusType) => {
      state = { status: statusType, statusType };
      expect(await note()).toEqual([]);
      expect(calls.find((c) => c.tool)).toMatchObject({
        tool: "get_issue",
        args: { id: "uuid-SAP-9" },
      });
      expect(posts()).toHaveLength(0);
      expect(comments()).toHaveLength(0);
    },
  );

  it("an open ticket gets one triage note and one Linear comment on its uuid", async () => {
    expect(await note()).toEqual([]);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].args).toMatchObject({
      channel: "C0TRIAGE001",
      threadTs: "1790889356.001",
      text: "<https://linear.app/x/issue/SAP-9|SAP-9> is still open in Linear. Cancel it there if it no longer needs work.",
    });
    expect(comments()).toEqual([
      expect.objectContaining({
        args: {
          issueId: "uuid-SAP-9",
          body: "Support desk ticket 41 was closed in Slack while this ticket was still open. Cancel this ticket if it no longer needs work.",
        },
      }),
    ]);
  });

  it("a failed Linear read warns and does nothing else", async () => {
    state = null;
    expect(await note()).toEqual(["linear state not read on close"]);
    expect(posts()).toHaveLength(0);
    expect(comments()).toHaveLength(0);
  });

  it("a failed comment still posts the note", async () => {
    failComment = true;
    expect(await note()).toEqual(["open Linear comment not added"]);
    expect(posts()).toHaveLength(1);
  });

  it("a failed Slack post still sends the comment", async () => {
    failMethod = "chat.postMessage";
    expect(await note()).toEqual(["open Linear note not posted"]);
    expect(comments()).toHaveLength(1);
  });

  it('a failed "Closed by" post still comments on the open ticket', async () => {
    // A live ctx reaches the database through the shared pool; point it at a local one.
    const db = await localFleetDb();
    await resetSharedDb(async () => ({ db, close: async () => {} }));
    const account = (await accountByChannel(db, "C0CUSTOMER1"))!;
    const opened = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "high",
      title: "Export fails",
      customer: { channel: "C0CUSTOMER1", ts: "1790889355.981" },
      triageRootTs: "1790889356.001",
    });
    await updateIssue(db, opened.id, {
      linearIssueId: "uuid-SAP-9",
      linearIdentifier: "SAP-9",
      linearUrl: "https://linear.app/x/issue/SAP-9",
    });
    await setStatus(db, opened.id, "on_hold");
    const close = structuredClone(
      fixture("slack/block-actions.issue-close.json").payload,
    ) as { actions: { value: string }[] };
    close.actions[0].value = opened.id;
    failMethod = "chat.postMessage";

    const made = fakeCtx({ isLocalTrace: false });
    (made.ctx.sapiom as Record<string, unknown>).database = {
      get: async () => ({
        connection: { connectionString: "postgres://local" },
      }),
    };
    await expect(run(close, made.ctx)).rejects.toThrow();
    expect((await getIssue(db, opened.id)).status).toBe("closed");
    expect(comments()).toHaveLength(1);
    await resetSharedDb();
  });

  it("no triage thread: no note, the comment still goes", async () => {
    expect(await note({ ...issue, triageRootTs: null })).toEqual([]);
    expect(posts()).toHaveLength(0);
    expect(comments()).toHaveLength(1);
  });
});
