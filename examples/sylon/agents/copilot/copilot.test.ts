/** The copilot on a local trace: real step code, the fixture world in pg-mem, no Slack, a stubbed LLM. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/index";
import { localFleetDb, setLocalDb, type Db } from "../../_shared/db";
import {
  createDraft,
  createDraftOnce,
  getDraft,
  getIssue,
  linkMessage,
  messageBySourceEventId,
  pendingDrafts,
  setDraftCard,
  setStatus,
} from "../../_shared/issues";
import { KB } from "../../_shared/kb.generated";
import { fakeCtx } from "../../_shared/test-ctx";
import {
  MAX_MESSAGE_CHARS,
  MAX_PROMPT_MESSAGES,
  buildPrompt,
  copilotCard,
  normalizeOutput,
  outputSchema,
  promptMessages,
  type DraftOutput,
} from "./draft";
import { agent } from "./index";
import {
  FIXTURE_DECIDED_DRAFT,
  FIXTURE_DRAFT,
  FIXTURE_ISSUE,
  seedLocalFixtures,
} from "./local";

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

const DIR = path.dirname(fileURLToPath(import.meta.url));
const own = (file: string) =>
  JSON.parse(
    readFileSync(path.join(DIR, "../../fixtures/copilot", file), "utf8"),
  ).payload as Record<string, unknown>;

const DRAFTED: DraftOutput = {
  summary: "Webhook signatures fail since this morning.",
  reply:
    "Nothing changed on our side. Verify the signature against the raw body bytes.",
  citations: ["webhooks", "not-a-page"],
  confidence: 0.8,
};

function ctxFor(executionId: string, drafted: DraftOutput = DRAFTED) {
  const fake = fakeCtx({ isLocalTrace: true, executionId });
  const llmCalls: Record<string, unknown>[] = [];
  (fake.ctx.sapiom as Record<string, unknown>).llm = {
    async run(spec: Record<string, unknown>) {
      llmCalls.push(spec);
      return {
        content: [
          { type: "tool_use", name: "draft_reply", input: { ...drafted } },
        ],
      };
    },
    structuredOf(response: { content: { input: unknown }[] }) {
      return response.content[0]?.input;
    },
  };
  const slack = (method: string) =>
    fake.logs
      .filter((l) => l.msg === `slack ${method} (local trace, not sent)`)
      .map((l) => (l.data as { args: Record<string, unknown> }).args);
  return { ...fake, llmCalls, slack };
}

/** Walk the agent from `route` the way the engine would, returning every directive. */
async function runAgent(input: unknown, ctx: unknown): Promise<Directive[]> {
  const out: Directive[] = [];
  let name = "receive";
  let value = input;
  for (;;) {
    const d = await step(name).run(value, ctx);
    out.push(d);
    if (d.kind !== "continue") return out;
    name = d.stepName!;
    value = d.input;
  }
}
const last = (ds: Directive[]) => ds[ds.length - 1];

let db: Db;
beforeEach(async () => {
  db = await localFleetDb();
  await seedLocalFixtures(db);
  setLocalDb(db);
});

describe("receive", () => {
  it.each([
    ["slack/block-actions.draft-approve.json", "decide"],
    ["slack/block-actions.draft-escalate.json", "decide"],
    ["slack/block-actions.draft-dismiss.json", "decide"],
  ])("%s goes to %s", async (file, target) => {
    const d = await step("receive").run(fixture(file).payload, ctxFor("x").ctx);
    expect(d.kind).toBe("continue");
    expect(d.stepName).toBe(target);
  });

  it("exits on issue.* clicks (intake's) and buttons Sylon does not ship", async () => {
    for (const payload of [
      fixture("slack/block-actions.issue-take.json").payload,
      fixture("slack/block-actions.issue-close.json").payload,
      own("block-actions.foreign.json"),
    ]) {
      const d = await step("receive").run(payload, ctxFor("x").ctx);
      expect(d.kind).toBe("terminate");
      expect(d.output).toHaveProperty("skipped");
    }
  });
});

describe("draft path", () => {
  it("issue.created supersedes the pending draft, drafts once, and posts a card in the triage thread", async () => {
    const t = ctxFor("exec-draft");
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    expect(ds.map((d) => d.kind)).toEqual(["terminate"]);

    expect(t.llmCalls).toHaveLength(1);
    const spec = t.llmCalls[0] as {
      model?: string;
      request: { max_tokens: number; messages: { content: string }[] };
    };
    expect(spec.model).toBeUndefined();
    expect(spec.request.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(spec.request.messages[0].content).toContain(
      "signature errors. Did something change?",
    );
    expect(spec.request.messages[0].content).toContain(
      '<page slug="webhooks">',
    );

    const old = await getDraft(db, FIXTURE_DRAFT);
    expect(old).toMatchObject({ status: "superseded", decidedBy: "copilot" });
    const [updated] = t.slack("chat.update");
    expect(updated).toMatchObject({ ts: "1790889450.000250" });
    expect(JSON.stringify(updated.blocks)).toContain(
      "Superseded by a newer draft",
    );
    expect(JSON.stringify(updated.blocks)).not.toContain("<@copilot>");

    const out = last(ds).output!;
    const draft = await getDraft(db, out.draftId as string);
    expect(draft).toMatchObject({
      status: "pending",
      text: DRAFTED.reply,
      cardChannel: "C0TRIAGE001",
      citations: ["webhooks"],
      causationId: "Ev0EXAMPLE01",
      confidence: 0.8,
    });
    const [posted] = t.slack("chat.postMessage");
    expect(posted).toMatchObject({
      channel: "C0TRIAGE001",
      threadTs: "1790889400.000200",
    });
    expect(posted.blocks).toEqual(
      copilotCard(draft, await getIssue(db, FIXTURE_ISSUE), KB),
    );
    expect((await getIssue(db, FIXTURE_ISSUE)).summary).toBe(DRAFTED.summary);
  });

  it("a redelivered event reuses its draft: no second LLM call, no second card", async () => {
    const payload = fixture("issue/created.json").payload;
    const first = last(await runAgent(payload, ctxFor("exec-1").ctx));
    const t = ctxFor("exec-2");
    const again = last(await runAgent(payload, t.ctx));
    expect(again.output).toMatchObject({
      draftId: first.output!.draftId,
      reused: true,
    });
    expect(t.llmCalls).toHaveLength(0);
    expect(t.slack("chat.postMessage")).toHaveLength(0);
    expect(await pendingDrafts(db, FIXTURE_ISSUE)).toHaveLength(1);
  });

  it("a retry after the draft was stored but before its card was posted posts the card without redrafting", async () => {
    const stored = await createDraft(db, {
      issueId: FIXTURE_ISSUE,
      text: "Stored by an earlier attempt.",
      citations: [],
      causationId: "Ev0EXAMPLE01",
      confidence: 0.5,
    });
    const t = ctxFor("exec-retry");
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    expect(last(ds).output).toMatchObject({
      draftId: stored.id,
      reused: false,
    });
    expect(t.llmCalls).toHaveLength(0);
    expect(t.slack("chat.postMessage")).toHaveLength(1);
    expect((await getDraft(db, stored.id)).cardTs).not.toBeNull();
  });

  it("issue.message_added replaces the previous draft with a new one", async () => {
    const created = last(
      await runAgent(fixture("issue/created.json").payload, ctxFor("e1").ctx),
    );
    const added = last(
      await runAgent(
        fixture("issue/message-added.json").payload,
        ctxFor("e2").ctx,
      ),
    );
    expect(added.output!.draftId).not.toBe(created.output!.draftId);
    expect((await getDraft(db, created.output!.draftId as string)).status).toBe(
      "superseded",
    );
    expect((await pendingDrafts(db, FIXTURE_ISSUE)).map((d) => d.id)).toEqual([
      added.output!.draftId,
    ]);
  });

  it("a follow-up not yet stored on the issue still reaches the prompt", async () => {
    const t = ctxFor("e");
    await runAgent(fixture("issue/message-added.json").payload, t.ctx);
    const spec = t.llmCalls[0] as {
      request: { messages: { content: string }[] };
    };
    expect(spec.request.messages[0].content).toContain(
      "Following up: it still fails after a retry.",
    );
  });

  it("an empty reply stores the summary, posts no card, and leaves the old draft actionable", async () => {
    const t = ctxFor("e", { ...DRAFTED, reply: "  " });
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    expect(last(ds).output).toMatchObject({ skipped: "no reply needed" });
    expect(t.slack("chat.postMessage")).toHaveLength(0);
    expect(t.slack("chat.update")).toHaveLength(0);
    expect((await pendingDrafts(db, FIXTURE_ISSUE)).map((d) => d.id)).toEqual([
      FIXTURE_DRAFT,
    ]);
    expect((await getIssue(db, FIXTURE_ISSUE)).summary).toBe(DRAFTED.summary);
  });

  it("a model error leaves the old draft actionable", async () => {
    const t = ctxFor("e");
    (t.ctx.sapiom as { llm: { run: () => Promise<never> } }).llm.run =
      async () => {
        throw new Error("model unavailable");
      };
    await expect(
      runAgent(fixture("issue/created.json").payload, t.ctx),
    ).rejects.toThrow("model unavailable");
    expect((await getDraft(db, FIXTURE_DRAFT)).status).toBe("pending");
    expect(t.slack("chat.update")).toHaveLength(0);
  });

  it("concurrent deliveries of one event post exactly one card", async () => {
    const payload = fixture("issue/created.json").payload;
    const a = ctxFor("exec-a");
    const b = ctxFor("exec-b");
    const [ra, rb] = await Promise.all([
      runAgent(payload, a.ctx),
      runAgent(payload, b.ctx),
    ]);
    const posts = [
      ...a.slack("chat.postMessage"),
      ...b.slack("chat.postMessage"),
    ];
    expect(posts).toHaveLength(1);
    const outs = [last(ra).output!, last(rb).output!];
    expect(outs[0].draftId).toBe(outs[1].draftId);
    expect(outs[0].cardTs).toBe(outs[1].cardTs);
    expect((await pendingDrafts(db, FIXTURE_ISSUE)).map((d) => d.id)).toEqual([
      outs[0].draftId,
    ]);
  });

  it("overlapping deliveries that both find the stored draft without a card post one card", async () => {
    const stored = await createDraftOnce(db, {
      issueId: FIXTURE_ISSUE,
      text: "Stored by an earlier attempt.",
      citations: [],
      causationId: "Ev0EXAMPLE01",
    });
    const payload = fixture("issue/created.json").payload;
    const a = ctxFor("exec-a");
    const b = ctxFor("exec-b");
    await Promise.all([runAgent(payload, a.ctx), runAgent(payload, b.ctx)]);
    expect([
      ...a.slack("chat.postMessage"),
      ...b.slack("chat.postMessage"),
    ]).toHaveLength(1);
    expect(a.llmCalls.length + b.llmCalls.length).toBe(0);
    expect((await getDraft(db, stored.draft.id)).cardTs).not.toBeNull();
  });

  it("an older event that publishes after a newer one retires its own draft instead of posting", async () => {
    // A (the root message) passes the pending check, then B (a later follow-up) publishes first.
    const a = ctxFor("exec-a");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = (
      a.ctx.sapiom as { llm: { run: (s: unknown) => Promise<unknown> } }
    ).llm;
    const run = llm.run.bind(llm);
    llm.run = async (spec) => {
      await gate;
      return run(spec);
    };
    const pendingA = runAgent(fixture("issue/created.json").payload, a.ctx);
    await new Promise((r) => setTimeout(r, 20));
    const b = ctxFor("exec-b");
    await linkMessage(db, {
      issueId: FIXTURE_ISSUE,
      source: "slack",
      sourceEventId: "Ev0SYLONREPLY1",
      direction: "customer",
      slack: {
        channel: "C0CUSTOMER1",
        ts: "1790889500.000300",
        threadTs: "1790889355.981329",
      },
      userId: "U0CUSTOMER1",
      text: "Following up: it still fails after a retry.",
    });
    const rb = await runAgent(
      fixture("issue/message-added.json").payload,
      b.ctx,
    );
    release();
    const ra = await pendingA;
    expect(last(ra).output).toMatchObject({
      skipped: "a newer message already has a pending draft",
    });
    // A got past the pre-LLM check, so the publish step is what stopped it.
    expect(a.llmCalls).toHaveLength(1);
    expect(a.slack("chat.postMessage")).toHaveLength(0);
    expect((await pendingDrafts(db, FIXTURE_ISSUE)).map((d) => d.id)).toEqual([
      last(rb).output!.draftId,
    ]);
  });

  it("a late event does not replace the posted draft for a newer customer message", async () => {
    await linkMessage(db, {
      issueId: FIXTURE_ISSUE,
      source: "slack",
      sourceEventId: "Ev0NEWER0001",
      direction: "customer",
      slack: {
        channel: "C0CUSTOMER1",
        ts: "1790889999.000100",
        threadTs: "1790889355.981329",
      },
      userId: "U0CUSTOMER1",
      text: "A newer follow-up.",
    });
    const newer = await createDraftOnce(db, {
      issueId: FIXTURE_ISSUE,
      text: "Reply to the newer follow-up.",
      causationId: "Ev0NEWER0001",
    });
    await setDraftCard(db, newer.draft.id, {
      channel: "C0TRIAGE001",
      ts: "1790890000.000100",
    });
    const t = ctxFor("e");
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    expect(last(ds).output).toMatchObject({
      skipped: "a newer message already has a pending draft",
      draftId: newer.draft.id,
    });
    expect(t.llmCalls).toHaveLength(0);
    expect((await getDraft(db, newer.draft.id)).status).toBe("pending");
  });

  it("an older event still publishes when the newer draft's card never got posted", async () => {
    await linkMessage(db, {
      issueId: FIXTURE_ISSUE,
      source: "slack",
      sourceEventId: "Ev0NEWER0002",
      direction: "customer",
      slack: {
        channel: "C0CUSTOMER1",
        ts: "1790889999.000200",
        threadTs: "1790889355.981329",
      },
      userId: "U0CUSTOMER1",
      text: "A newer follow-up whose card post failed.",
    });
    // The newer run stored its draft, then its Slack post failed: no card.
    const newer = await createDraftOnce(db, {
      issueId: FIXTURE_ISSUE,
      text: "Reply to the newer follow-up.",
      causationId: "Ev0NEWER0002",
    });
    const t = ctxFor("e");
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    const out = last(ds).output!;
    expect(out).toMatchObject({ status: "pending", reused: false });
    expect(t.slack("chat.postMessage")).toHaveLength(1);
    const actionable = (await pendingDrafts(db, FIXTURE_ISSUE)).filter(
      (d) => d.cardTs,
    );
    expect(actionable.map((d) => d.id)).toEqual([out.draftId]);
    // The newer draft is left for its own run's retry, which will supersede this one.
    expect((await getDraft(db, newer.draft.id)).status).toBe("pending");
  });

  it("internal notes never reach the model", async () => {
    await linkMessage(db, {
      issueId: FIXTURE_ISSUE,
      source: "slack",
      sourceEventId: "Ev0INTERNAL1",
      direction: "internal",
      slack: { channel: "C0TRIAGE001", ts: "1790889420.000100" },
      userId: "U0TEAMMATE1",
      text: "Internal: codename BLUEHERON, do not tell the customer.",
    });
    const t = ctxFor("e");
    await runAgent(fixture("issue/created.json").payload, t.ctx);
    expect(JSON.stringify(t.llmCalls)).not.toContain("BLUEHERON");
    expect(JSON.stringify(t.llmCalls)).toContain("signature errors");
  });

  it("does not draft for a closed issue", async () => {
    await setStatus(db, FIXTURE_ISSUE, "closed");
    const t = ctxFor("e");
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    expect(last(ds).output).toMatchObject({ skipped: "issue is closed" });
    expect(t.llmCalls).toHaveLength(0);
  });
});

describe("click path", () => {
  it("Approve posts the reply in the customer thread, moves to On Customer, and updates the card; a second click changes nothing", async () => {
    const click = fixture("slack/block-actions.draft-approve.json").payload;
    const t = ctxFor("exec-approve");
    const ds = await runAgent(click, t.ctx);
    expect(last(ds).output).toMatchObject({
      changed: true,
      status: "approved",
      issueStatus: "on_customer",
    });
    const [reply] = t.slack("chat.postMessage");
    expect(reply).toMatchObject({
      channel: "C0CUSTOMER1",
      threadTs: "1790889355.981329",
    });
    const sent = await messageBySourceEventId(db, `draft:${FIXTURE_DRAFT}`);
    expect(sent).toMatchObject({ direction: "agent", issueId: FIXTURE_ISSUE });
    expect(await getDraft(db, FIXTURE_DRAFT)).toMatchObject({
      status: "approved",
      decidedBy: "U0TEAMMATE1",
    });
    const updates = t.slack("chat.update");
    expect(updates.map((u) => u.ts)).toEqual([
      "1790889400.000200", // the issue card, now On Customer
      "1790889450.000250", // the draft card
    ]);
    expect(JSON.stringify(updates[1].blocks)).toContain(
      "Approved and sent by <@U0TEAMMATE1>",
    );

    const t2 = ctxFor("exec-approve-2");
    const again = await runAgent(click, t2.ctx);
    expect(last(again).output).toMatchObject({
      changed: false,
      decidedBy: "U0TEAMMATE1",
    });
    expect(t2.slack("chat.postMessage")).toHaveLength(0);
    expect(t2.slack("chat.update")).toHaveLength(1);
  });

  it("Approve on a closed issue sends nothing and dismisses the draft", async () => {
    await setStatus(db, FIXTURE_ISSUE, "closed");
    const t = ctxFor("e");
    const ds = await runAgent(
      fixture("slack/block-actions.draft-approve.json").payload,
      t.ctx,
    );
    expect(last(ds).output).toMatchObject({
      skipped: "issue is closed",
      status: "dismissed",
    });
    expect(t.slack("chat.postMessage")).toHaveLength(0);
    expect(
      await messageBySourceEventId(db, `draft:${FIXTURE_DRAFT}`),
    ).toBeNull();
    expect(await getDraft(db, FIXTURE_DRAFT)).toMatchObject({
      status: "dismissed",
      decidedBy: "U0TEAMMATE1",
    });
    expect(JSON.stringify(t.slack("chat.update")[0].blocks)).toContain(
      "Issue is closed; reply not sent.",
    );
  });

  it("an issue closed between the decision and the send keeps the approval but sends nothing", async () => {
    const t = ctxFor("e");
    const click = fixture("slack/block-actions.draft-approve.json").payload;
    const decided = await step("decide").run(click, t.ctx);
    expect(decided.stepName).toBe("apply");
    await setStatus(db, FIXTURE_ISSUE, "closed");
    const done = await step("apply").run(decided.input, t.ctx);
    expect(done.output).toMatchObject({
      replySent: false,
      issueStatus: "closed",
    });
    expect(t.slack("chat.postMessage")).toHaveLength(0);
    expect(
      await messageBySourceEventId(db, `draft:${FIXTURE_DRAFT}`),
    ).toBeNull();
    expect((await getDraft(db, FIXTURE_DRAFT)).status).toBe("approved");
    const card = JSON.stringify(t.slack("chat.update").at(-1)!.blocks);
    expect(card).toContain(
      "Approved by <@U0TEAMMATE1>; issue closed before sending, reply not sent",
    );
    expect(card).not.toContain("Approved and sent");
  });

  it("a retry after the reply went out still reports it sent, even if the issue closed since", async () => {
    const t = ctxFor("e");
    const ds = await runAgent(
      fixture("slack/block-actions.draft-approve.json").payload,
      t.ctx,
    );
    await setStatus(db, FIXTURE_ISSUE, "closed");
    const retry = await step("apply").run(ds[1].input, t.ctx);
    expect(retry.output).toHaveProperty("replyTs");
    expect(
      t.slack("chat.postMessage").filter((p) => p.channel === "C0CUSTOMER1"),
    ).toHaveLength(1);
  });

  it("a retried apply step does not post the reply twice", async () => {
    const click = fixture("slack/block-actions.draft-approve.json").payload;
    const t = ctxFor("exec-apply");
    const ds = await runAgent(click, t.ctx);
    await step("apply").run(ds[1].input, t.ctx);
    expect(
      t.slack("chat.postMessage").filter((p) => p.channel === "C0CUSTOMER1"),
    ).toHaveLength(1);
  });

  it("Approve on an On Hold issue sends the reply but leaves the status, and says so on the card", async () => {
    await setStatus(db, FIXTURE_ISSUE, "on_hold");
    const t = ctxFor("e");
    const ds = await runAgent(
      fixture("slack/block-actions.draft-approve.json").payload,
      t.ctx,
    );
    expect(last(ds).output).toMatchObject({ issueStatus: "on_hold" });
    expect(t.slack("chat.postMessage")).toHaveLength(1);
    expect(JSON.stringify(t.slack("chat.update").at(-1)!.blocks)).toContain(
      "Status left at On Hold",
    );
  });

  it("Escalate emits issue.escalate keyed on the trigger_id", async () => {
    const t = ctxFor("e");
    const ds = await runAgent(
      fixture("slack/block-actions.draft-escalate.json").payload,
      t.ctx,
    );
    expect(last(ds).output).toMatchObject({ status: "escalated" });
    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0]).toMatchObject({
      type: "issue.escalate",
      id: "issue.escalate:1790889700.1004",
      payload: {
        issueId: FIXTURE_ISSUE,
        causationId: "1790889700.1004",
        requestedBy: "U0TEAMMATE1",
        slack: { channel: "C0CUSTOMER1", ts: "1790889355.981329" },
      },
    });
    expect(t.slack("chat.postMessage")).toHaveLength(0);
  });

  it("Dismiss only records the decision and updates the card", async () => {
    const t = ctxFor("e");
    const ds = await runAgent(
      fixture("slack/block-actions.draft-dismiss.json").payload,
      t.ctx,
    );
    expect(last(ds).output).toMatchObject({ status: "dismissed" });
    expect(t.emitted).toHaveLength(0);
    expect(t.slack("chat.postMessage")).toHaveLength(0);
    expect(JSON.stringify(t.slack("chat.update")[0].blocks)).toContain(
      "Dismissed by <@U0TEAMMATE1>",
    );
  });

  it("a click on an already-decided draft shows who decided and does nothing else", async () => {
    const t = ctxFor("e");
    const ds = await runAgent(
      own("block-actions.draft-approve.decided.json"),
      t.ctx,
    );
    expect(last(ds).output).toMatchObject({
      draftId: FIXTURE_DECIDED_DRAFT,
      changed: false,
      decidedBy: "U0TEAMMATE2",
    });
    expect(t.slack("chat.postMessage")).toHaveLength(0);
    expect(JSON.stringify(t.slack("chat.update")[0].blocks)).toContain(
      "Approved and sent by <@U0TEAMMATE2>",
    );
  });
});

describe("draft helpers", () => {
  it("normalizeOutput drops unknown citations and clamps confidence", () => {
    expect(
      normalizeOutput(
        { ...DRAFTED, confidence: 3, citations: ["x", "billing", "billing"] },
        KB,
      ),
    ).toMatchObject({ confidence: 1, citations: ["billing"] });
  });

  it("promptMessages keeps the first customer message and the latest ones, never internal notes", () => {
    const msg = (i: number, direction: "customer" | "agent" | "internal") =>
      ({ id: `m${i}`, direction, text: `t${i}` }) as never;
    const all = [
      msg(0, "customer"),
      ...Array.from({ length: 30 }, (_, i) =>
        msg(i + 1, i % 3 === 0 ? "internal" : "customer"),
      ),
    ];
    const kept = promptMessages(all) as { id: string; direction: string }[];
    expect(kept).toHaveLength(MAX_PROMPT_MESSAGES);
    expect(kept[0].id).toBe("m0");
    expect(kept.at(-1)!.id).toBe("m30");
    expect(kept.some((m) => m.direction === "internal")).toBe(false);
  });

  it("buildPrompt truncates long messages", () => {
    const long = "x".repeat(MAX_MESSAGE_CHARS + 500);
    const prompt = buildPrompt({
      issue: { number: 1, status: "new", title: "t" } as never,
      account: { name: "A" } as never,
      messages: [{ id: "m", direction: "customer", text: long } as never],
      kb: KB,
    });
    expect(prompt).toContain("[truncated]");
    expect(prompt).not.toContain("x".repeat(MAX_MESSAGE_CHARS + 1));
  });

  it("the output schema limits citations to kb slugs", () => {
    const schema = outputSchema(KB) as {
      properties: { citations: { items: { enum: string[] } } };
    };
    expect(schema.properties.citations.items.enum).toEqual(
      KB.map((p) => p.slug),
    );
  });
});
