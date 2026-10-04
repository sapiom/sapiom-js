/** The copilot on a local trace: real step code, the fixture world in pg-mem, no Slack, a stubbed LLM. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixture } from "../../fixtures/index";
import {
  localFleetDb,
  resetSharedDb,
  setLocalDb,
  type Db,
} from "../../_shared/db";
import { upsertDesk } from "../../_shared/desks";
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
import { localFetcher, setDocsFetcher } from "../../_shared/docs";
import { createArticle } from "../../_shared/kb";
import { fakeCtx } from "../../_shared/test-ctx";
import {
  DRAFT_FAILED_NOTE,
  MAX_MESSAGE_CHARS,
  MAX_PROMPT_MESSAGES,
  buildPrompt,
  copilotCard,
  normalizeOutput,
  outputSchema,
  promptMessages,
  sourceLabel,
  TOOL_REMINDER,
  type DraftOutput,
} from "./draft";
import { agent } from "./index";
import {
  FIXTURE_DECIDED_DRAFT,
  FIXTURE_DRAFT,
  FIXTURE_ISSUE,
  seedLocalFixtures,
} from "./local";

// SAP-3721: exercise retries across the gap between Slack acceptance and database persistence.
const failOnce = vi.hoisted(() => ({
  linkMessage: false,
  setDraftCard: false,
}));
vi.mock("../../_shared/issues", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../_shared/issues")>();
  const once =
    <A extends unknown[], R>(
      name: keyof typeof failOnce,
      fn: (...a: A) => Promise<R>,
    ) =>
    async (...a: A): Promise<R> => {
      if (failOnce[name]) {
        failOnce[name] = false;
        throw new Error(`${name} failed`);
      }
      return fn(...a);
    };
  return {
    ...real,
    linkMessage: once("linkMessage", real.linkMessage),
    setDraftCard: once("setDraftCard", real.setDraftCard),
  };
});

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

/** The page the stubbed selection call picks; it is in the local trace's docs index. */
const DEPLOY_PAGE = "https://docs.sapiom.ai/guides/deploy";

const DRAFTED: DraftOutput = {
  summary: "Webhook signatures fail since this morning.",
  reply:
    "Nothing changed on our side. Verify the signature against the raw body bytes.",
  citations: [DEPLOY_PAGE, "not-a-page"],
  confidence: 0.8,
};

function ctxFor(executionId: string, drafted: DraftOutput = DRAFTED) {
  const fake = fakeCtx({ isLocalTrace: true, executionId });
  /** Drafting calls only; the selection call is in `selectCalls`. */
  const llmCalls: Record<string, unknown>[] = [];
  const selectCalls: Record<string, unknown>[] = [];
  (fake.ctx.sapiom as Record<string, unknown>).llm = {
    async run(spec: Record<string, unknown>) {
      const name = (spec.output as { name: string }).name;
      if (name === "select_sources") {
        selectCalls.push(spec);
        return {
          content: [
            {
              type: "tool_use",
              name,
              input: { docs: [DEPLOY_PAGE, "https://evil.example/x"] },
            },
          ],
        };
      }
      llmCalls.push(spec);
      return {
        content: [{ type: "tool_use", name, input: { ...drafted } }],
      };
    },
    structuredOf(
      response: { content: { name?: string; input: unknown }[] },
      name?: string,
    ) {
      return response.content.find((b) => !name || b.name === name)?.input;
    },
  };
  const slack = (method: string) =>
    fake.logs
      .filter((l) => l.msg === `slack ${method} (local trace, not sent)`)
      .map((l) => (l.data as { args: Record<string, unknown> }).args);
  return { ...fake, llmCalls, selectCalls, slack };
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

  it("exits on issue.* clicks (intake's) and buttons the support desk does not ship", async () => {
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
    expect(spec.model).toBe("sonnet");
    expect(spec.request.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(spec.request.messages[0].content).toContain(
      "signature errors. Did something change?",
    );
    expect(spec.request.messages[0].content).toContain(
      `<page url="${DEPLOY_PAGE}"`,
    );
    expect(spec.request.messages[0].content).toContain("Local trace:");

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
      citations: [DEPLOY_PAGE],
      causationId: "Ev0EXAMPLE01",
      confidence: 0.8,
    });
    const [posted] = t.slack("chat.postMessage");
    expect(posted).toMatchObject({
      channel: "C0TRIAGE001",
      threadTs: "1790889400.000200",
    });
    const [header, ...rest] = copilotCard(
      draft,
      await getIssue(db, FIXTURE_ISSUE),
      new Map(),
    );
    expect(posted.blocks).toEqual([
      { ...header, block_id: `sylon:draft-card:${draft.id}` },
      ...rest,
    ]);
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

  /** Answer in plain text, without the forced tool call, the first `misses` times. */
  function skipToolCall(t: ReturnType<typeof ctxFor>, misses: number) {
    const llm = (
      t.ctx.sapiom as { llm: { run: (s: unknown) => Promise<unknown> } }
    ).llm;
    const run = llm.run.bind(llm);
    let calls = 0;
    llm.run = async (spec) => {
      const name = (spec as { output: { name: string } }).output.name;
      if (name !== "draft_reply" || calls++ >= misses) return run(spec);
      t.llmCalls.push(spec as Record<string, unknown>);
      // What `llm.run` does with a forced tool call the model skipped (SAP-3782).
      throw Object.assign(new Error("model did not call the tool"), {
        name: "LlmStructuredOutputMissingError",
        response: {
          stop_reason: "end_turn",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: "Here is a draft." },
          ],
        },
      });
    };
  }
  const systemOf = (spec: Record<string, unknown>) =>
    (spec.request as { system: string }).system;

  it("a response without the tool call is logged and retried once with a reminder", async () => {
    const t = ctxFor("e");
    skipToolCall(t, 1);
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    expect(t.llmCalls).toHaveLength(2);
    expect(systemOf(t.llmCalls[0])).not.toContain(TOOL_REMINDER);
    expect(systemOf(t.llmCalls[1])).toContain(TOOL_REMINDER);
    expect(
      t.logs.find((l) => l.msg === "draft response has no structured output"),
    ).toMatchObject({
      level: "warn",
      data: {
        attempt: 1,
        stopReason: "end_turn",
        blockTypes: ["thinking", "text"],
      },
    });
    const draft = await getDraft(db, last(ds).output!.draftId as string);
    expect(draft).toMatchObject({ status: "pending", text: DRAFTED.reply });
    expect(t.slack("chat.postMessage")).toHaveLength(1);
  });

  it("two responses without the tool call end the run, note it in the triage thread, and keep the old draft", async () => {
    const t = ctxFor("e");
    skipToolCall(t, 2);
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    expect(ds.map((d) => d.kind)).toEqual(["terminate"]);
    expect(last(ds).output).toMatchObject({ skipped: "no structured draft" });
    expect(t.llmCalls).toHaveLength(2);
    expect(t.slack("chat.postMessage")).toEqual([
      expect.objectContaining({
        channel: "C0TRIAGE001",
        threadTs: "1790889400.000200",
        text: DRAFT_FAILED_NOTE,
      }),
    ]);
    expect((await pendingDrafts(db, FIXTURE_ISSUE)).map((d) => d.id)).toEqual([
      FIXTURE_DRAFT,
    ]);
    expect(t.slack("chat.update")).toHaveLength(0);
  });

  it("a failed note post is logged and still ends the run without another model call", async () => {
    const t = ctxFor("e");
    skipToolCall(t, 2);
    // On a local trace a post is only this log line; throwing here fails the post.
    const info = t.ctx.logger.info;
    t.ctx.logger.info = (msg: string, data?: unknown) => {
      if (msg.startsWith("slack chat.postMessage"))
        throw new Error("slack down");
      info(msg, data);
    };
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    expect(last(ds).output).toMatchObject({ skipped: "no structured draft" });
    expect(t.llmCalls).toHaveLength(2);
    expect(
      t.logs.find((l) => l.msg === "draft-failed note not posted; continuing"),
    ).toMatchObject({ level: "warn" });
  });

  it("publishes, without a note, the draft a concurrent delivery stored while ours missed", async () => {
    const t = ctxFor("e");
    skipToolCall(t, 2);
    const llm = (
      t.ctx.sapiom as { llm: { run: (s: unknown) => Promise<unknown> } }
    ).llm;
    const run = llm.run.bind(llm);
    llm.run = async (spec) => {
      try {
        return await run(spec);
      } finally {
        if (t.llmCalls.length === 2)
          await createDraftOnce(db, {
            issueId: FIXTURE_ISSUE,
            text: "drafted by the other delivery",
            citations: [],
            causationId: "Ev0EXAMPLE01",
            confidence: 0.7,
          });
      }
    };
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    // The other delivery's row has no card yet (its post failed or is in flight): ours posts it.
    const out = last(ds).output!;
    const draft = await getDraft(db, out.draftId as string);
    expect(draft).toMatchObject({
      text: "drafted by the other delivery",
      status: "pending",
    });
    expect(out).toMatchObject({ cardTs: draft.cardTs, reused: false });
    const posted = t.slack("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0].text).not.toBe(DRAFT_FAILED_NOTE);
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
      sourceEventId: "Ev0DESKREPLY1",
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

  const ORIGINAL_BLOCKS = [
    { type: "section", text: { type: "mrkdwn", text: "Draft body" } },
    {
      type: "actions",
      block_id: "draft.actions",
      elements: [{ type: "button", action_id: "draft.approve" }],
    },
  ];
  const clickWithCard = (value?: string) => {
    const click = structuredClone(
      fixture("slack/block-actions.draft-approve.json").payload,
    ) as {
      message: { blocks: unknown[] };
      actions: { value: string }[];
    };
    click.message.blocks = structuredClone(ORIGINAL_BLOCKS);
    if (value !== undefined) click.actions[0].value = value;
    return click;
  };

  it("shows Approving on the clicked card first and ends on the decided draft card", async () => {
    const t = ctxFor("exec-working");
    await runAgent(clickWithCard(), t.ctx);
    const clicked = t
      .slack("chat.update")
      .filter((u) => u.ts === "1790889450.000250");
    expect(JSON.stringify(t.slack("chat.update")[0].blocks)).toContain(
      "Approving…",
    );
    expect(t.slack("chat.update")[0].ts).toBe("1790889450.000250");
    expect(JSON.stringify(clicked.at(-1)!.blocks)).toContain(
      "Approved and sent by <@U0TEAMMATE1>",
    );
    expect(JSON.stringify(clicked.at(-1)!.blocks)).not.toContain("Approving");
  });

  it("shows no working card for a click whose value is not a draft id", async () => {
    const t = ctxFor("exec-bad-value");
    const ds = await runAgent(clickWithCard("not-a-uuid"), t.ctx);
    expect(last(ds).output).toMatchObject({
      skipped: "value is not a draftId",
    });
    expect(t.slack("chat.update")).toHaveLength(0);
  });

  it("restores the clicked card when the draft is not found", async () => {
    const t = ctxFor("exec-missing");
    const ds = await runAgent(
      clickWithCard("00000000-0000-4000-8000-000000000000"),
      t.ctx,
    );
    expect(last(ds).output).toMatchObject({ skipped: "draft not found" });
    const updates = t.slack("chat.update");
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates[0].blocks)).toContain("Approving…");
    expect(updates[1]).toMatchObject({
      ts: "1790889450.000250",
      blocks: ORIGINAL_BLOCKS,
    });
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

  it("a stale click after an unsent approval still says the reply was not sent", async () => {
    const click = fixture("slack/block-actions.draft-approve.json").payload;
    const t = ctxFor("e");
    const decided = await step("decide").run(click, t.ctx);
    await setStatus(db, FIXTURE_ISSUE, "closed");
    await step("apply").run(decided.input, t.ctx);
    const notSent =
      "Approved by <@U0TEAMMATE1>; issue closed before sending, reply not sent";
    // A stale click while the issue is still closed.
    const t1 = ctxFor("e1");
    await runAgent({ ...click, trigger_id: "1790889800.2000" }, t1.ctx);
    expect(JSON.stringify(t1.slack("chat.update")[0].blocks)).toContain(
      notSent,
    );
    expect((await getDraft(db, FIXTURE_DRAFT)).status).toBe("approved");
    // Reopened, so the second click takes the already-decided path rather than the closed one.
    await setStatus(db, FIXTURE_ISSUE, "on_you");
    const t2 = ctxFor("e2");
    const again = await runAgent(
      { ...click, trigger_id: "1790889800.2001" },
      t2.ctx,
    );
    expect(last(again).output).toMatchObject({
      changed: false,
      status: "approved",
    });
    const card = JSON.stringify(t2.slack("chat.update")[0].blocks);
    expect(card).toContain(
      "Approved by <@U0TEAMMATE1>; issue closed before sending, reply not sent",
    );
    expect(card).not.toContain("Approved and sent");
    expect(t2.slack("chat.postMessage")).toHaveLength(0);
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

describe("knowledge on the draft path", () => {
  const fakeIndex = async (url: string) =>
    url.endsWith("/llms.txt")
      ? "- [Deploy](https://docs.sapiom.ai/guides/deploy): Deploy it.\n"
      : "# Deploy\nrun it";
  const run = (t: ReturnType<typeof ctxFor>) =>
    runAgent(fixture("issue/created.json").payload, t.ctx);
  afterEach(() => setDocsFetcher(undefined));

  it("always puts enabled policies in the prompt and cites them by id", async () => {
    const policy = await createArticle(
      db,
      { kind: "policy", title: "Refunds", body: "Never promise a refund." },
      "test",
    );
    await createArticle(
      db,
      { kind: "policy", title: "Off", body: "DISABLEDTEXT", enabled: false },
      "test",
    );
    const t = ctxFor("e", { ...DRAFTED, citations: [policy.id, "bogus"] });
    const out = last(await run(t)).output!;
    const prompt = (
      t.llmCalls[0].request as { messages: { content: string }[] }
    ).messages[0].content;
    expect(prompt).toContain("Never promise a refund.");
    expect(prompt).not.toContain("DISABLEDTEXT");
    const draft = await getDraft(db, out.draftId as string);
    expect(draft.citations).toEqual([policy.id]);
  });

  it("drops selected urls that are not in the docs index", async () => {
    const t = ctxFor("e");
    await run(t);
    const prompt = (
      t.llmCalls[0].request as { messages: { content: string }[] }
    ).messages[0].content;
    expect(prompt).not.toContain("evil.example");
  });

  it("a docs outage still drafts from the team KB, caps confidence, and logs it", async () => {
    setDocsFetcher(async () => {
      throw new Error("docs down");
    });
    await createArticle(
      db,
      { kind: "policy", title: "Tone", body: "TEAMPOLICY" },
      "test",
    );
    const t = ctxFor("e");
    const out = last(await run(t)).output!;
    expect(t.selectCalls).toHaveLength(0);
    expect(out.confidence).toBe(0.5);
    const draft = await getDraft(db, out.draftId as string);
    expect(draft).toMatchObject({ status: "pending", confidence: 0.5 });
    const prompt = (
      t.llmCalls[0].request as { messages: { content: string }[] }
    ).messages[0].content;
    expect(prompt).toContain("TEAMPOLICY");
    expect(prompt).toContain("could not be read");
    expect(draft.citations).toEqual([]);
    expect(t.logs.some((l) => l.msg.includes("docs index unavailable"))).toBe(
      true,
    );
  });

  it("reads pages through the injected fetcher", async () => {
    setDocsFetcher(fakeIndex);
    const t = ctxFor("e");
    await run(t);
    const prompt = (
      t.llmCalls[0].request as { messages: { content: string }[] }
    ).messages[0].content;
    expect(prompt).toContain("# Deploy\nrun it");
  });
});

describe("desks", () => {
  const run = (t: ReturnType<typeof ctxFor>) =>
    runAgent(fixture("issue/created.json").payload, t.ctx);
  const promptOf = (t: ReturnType<typeof ctxFor>) =>
    (t.llmCalls[0].request as { messages: { content: string }[] }).messages[0]
      .content;

  /** Moves the fixture issue onto a second desk, `test`, with its own triage channel. */
  async function moveToTestDesk() {
    const desk = (
      await upsertDesk(db, {
        slug: "test",
        name: "Test",
        triageChannel: "C0TESTTRI01",
      })
    ).desk;
    await db.query("update issues set desk_id = $1 where id = $2", [
      desk.id,
      FIXTURE_ISSUE,
    ]);
    return desk;
  }

  it("posts the draft card and redraws the issue card in the issue's desk triage channel", async () => {
    await moveToTestDesk();
    const t = ctxFor("exec-desk-card");
    const out = last(await run(t)).output!;
    const [posted] = t.slack("chat.postMessage");
    expect(posted).toMatchObject({
      channel: "C0TESTTRI01",
      threadTs: "1790889400.000200",
    });
    expect((await getDraft(db, out.draftId as string)).cardChannel).toBe(
      "C0TESTTRI01",
    );
  });

  it("posts the draft-failed note in the issue's desk triage channel", async () => {
    await moveToTestDesk();
    const t = ctxFor("exec-desk-note");
    const llm = (
      t.ctx.sapiom as { llm: { run: (s: unknown) => Promise<unknown> } }
    ).llm;
    const original = llm.run.bind(llm);
    llm.run = async (spec) =>
      (spec as { output: { name: string } }).output.name === "draft_reply"
        ? { stop_reason: "end_turn", content: [{ type: "text", text: "Hi" }] }
        : original(spec);
    await run(t);
    expect(t.slack("chat.postMessage")).toEqual([
      expect.objectContaining({
        channel: "C0TESTTRI01",
        text: DRAFT_FAILED_NOTE,
      }),
    ]);
  });

  it("reads the issue's desk articles and the all-desks ones, never another desk's", async () => {
    const test = await moveToTestDesk();
    const other = (
      await upsertDesk(db, {
        slug: "other",
        name: "Other",
        triageChannel: "C0OTHERTRI",
      })
    ).desk;
    const policy = (title: string, body: string, deskId: string | null) =>
      createArticle(db, { kind: "policy", title, body, deskId }, "test");
    await policy("Everyone", "EVERYONE-RULE", null);
    await policy("Test only", "TEST-RULE", test.id);
    await policy("Other only", "OTHER-RULE", other.id);

    const t = ctxFor("exec-desk-kb");
    await run(t);
    const prompt = promptOf(t);
    expect(prompt).toContain("EVERYONE-RULE");
    expect(prompt).toContain("TEST-RULE");
    expect(prompt).not.toContain("OTHER-RULE");
  });
});

describe("draft helpers", () => {
  it("normalizeOutput drops citations the prompt did not provide and clamps confidence", () => {
    expect(
      normalizeOutput(
        {
          ...DRAFTED,
          confidence: 3,
          citations: ["x", DEPLOY_PAGE, DEPLOY_PAGE],
        },
        [DEPLOY_PAGE],
      ),
    ).toMatchObject({ confidence: 1, citations: [DEPLOY_PAGE] });
  });

  it("sourceLabel links docs pages and names articles, with a placeholder for a deleted one", () => {
    const titles = new Map([["id-1", "Refunds <b>"]]);
    expect(sourceLabel(DEPLOY_PAGE, titles)).toBe(
      `<${DEPLOY_PAGE}|guides/deploy>`,
    );
    expect(sourceLabel("id-1", titles)).toBe("Refunds &lt;b&gt;");
    expect(sourceLabel("gone", titles)).toBe("removed article");
  });

  it("sourceLabel never lets a stored url inject Slack markup", () => {
    const evil = "https://docs.sapiom.ai/a|b>c<!channel>";
    const out = sourceLabel(evil, new Map());
    expect(out).not.toContain("<");
    expect(out).not.toContain("|");
    expect(out).not.toContain(">");
    expect(sourceLabel("https://docs.sapiom.ai/a%7Cb", new Map())).not.toMatch(
      /^<https/,
    );
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

  it("buildPrompt truncates long messages and renders policies, answers and pages", () => {
    const long = "x".repeat(MAX_MESSAGE_CHARS + 500);
    const article = (kind: "policy" | "answer", id: string) =>
      ({ id, kind, title: `T ${id}`, body: `body ${id}` }) as never;
    const prompt = buildPrompt({
      issue: { number: 1, status: "new", title: "t" } as never,
      account: { name: "A" } as never,
      messages: [{ id: "m", direction: "customer", text: long } as never],
      knowledge: {
        policies: [article("policy", "p1")],
        answers: [article("answer", "a1")],
        docs: [{ url: DEPLOY_PAGE, title: "Deploy", body: "page text" }],
        docsUnavailable: false,
      },
    });
    expect(prompt).toContain("[truncated]");
    expect(prompt).not.toContain("x".repeat(MAX_MESSAGE_CHARS + 1));
    expect(prompt).toContain('<policy id="p1" title="T p1">');
    expect(prompt).toContain('<answer id="a1" title="T a1">');
    expect(prompt).toContain(`<page url="${DEPLOY_PAGE}" title="Deploy">`);
  });

  it("the output schema allows no citations when nothing was provided", () => {
    const schema = outputSchema([]) as {
      properties: { citations: { maxItems?: number } };
    };
    expect(schema.properties.citations.maxItems).toBe(0);
    expect(
      (outputSchema([DEPLOY_PAGE]) as typeof schema).properties.citations
        .maxItems,
    ).toBeUndefined();
  });
});

describe("a retry after Slack accepted the post (SAP-3721)", () => {
  type Sent = { method: string; args: Record<string, unknown> };

  // SAP-3721: Slack state must survive database rollback so retries can recover an unrecorded post.
  function liveCtx() {
    const t = ctxFor("exec-live");
    const sent: Sent[] = [];
    const threads = new Map<string, Record<string, unknown>[]>();
    let n = 0;
    const slack = {
      async postMessage(args: Record<string, unknown>) {
        sent.push({ method: "chat.postMessage", args });
        const ts = `1790990000.${String(++n).padStart(6, "0")}`;
        const root = `${args.channel}/${args.threadTs ?? ts}`;
        threads.set(root, [
          ...(threads.get(root) ?? []),
          { ts, bot_id: "B0SYLON", text: args.text, blocks: args.blocks },
        ]);
        return { ok: true, channel: args.channel, ts };
      },
      async replies(args: Record<string, unknown>) {
        sent.push({ method: "conversations.replies", args });
        return {
          ok: true,
          messages: threads.get(`${args.channel}/${args.ts}`) ?? [],
        };
      },
      async update(args: Record<string, unknown>) {
        sent.push({ method: "chat.update", args });
        return { ok: true, channel: args.channel, ts: args.ts };
      },
      async postEphemeral() {
        return { ok: true };
      },
      async addReaction() {
        return { ok: true };
      },
      async removeReaction() {
        return { ok: true };
      },
      async userInfo(args: { user: string }) {
        return { ok: true, user: { id: args.user, name: args.user } };
      },
    };
    (t.ctx as { isLocalTrace: boolean }).isLocalTrace = false;
    Object.assign(t.ctx.sapiom as Record<string, unknown>, {
      connectors: { slack },
      database: {
        get: async () => ({ connection: { connectionString: "pg-mem" } }),
      },
    });
    const posts = (channel: string) =>
      sent
        .filter((c) => c.method === "chat.postMessage")
        .filter((c) => c.args.channel === channel)
        .map((c) => c.args);
    return { ...t, sent, posts };
  }

  beforeEach(async () => {
    await resetSharedDb(async () => ({ db, close: async () => {} }));
    setDocsFetcher(localFetcher);
  });
  afterEach(async () => {
    failOnce.linkMessage = false;
    failOnce.setDraftCard = false;
    setDocsFetcher(undefined);
    await resetSharedDb();
  });

  it("apply finds the customer reply it already posted instead of posting it again", async () => {
    const local = ctxFor("exec-decide");
    const received = await step("receive").run(
      fixture("slack/block-actions.draft-approve.json").payload,
      local.ctx,
    );
    const decided = await step(received.stepName!).run(
      received.input,
      local.ctx,
    );
    expect(decided.stepName).toBe("apply");

    const live = liveCtx();
    failOnce.linkMessage = true;
    await expect(step("apply").run(decided.input, live.ctx)).rejects.toThrow(
      "linkMessage failed",
    );
    expect(
      await messageBySourceEventId(db, `draft:${FIXTURE_DRAFT}`),
    ).toBeNull();

    await step("apply").run(decided.input, live.ctx);
    const replies = live.posts("C0CUSTOMER1");
    expect(replies).toHaveLength(1);
    expect((replies[0].blocks as { block_id: string }[])[0].block_id).toBe(
      `sylon:draft:${FIXTURE_DRAFT}`,
    );
    expect(
      await messageBySourceEventId(db, `draft:${FIXTURE_DRAFT}`),
    ).toMatchObject({ ts: "1790990000.000001" });
  });

  it("receive finds the draft card it already posted instead of posting it again", async () => {
    const live = liveCtx();
    const created = fixture("issue/created.json").payload;
    failOnce.setDraftCard = true;
    await expect(step("receive").run(created, live.ctx)).rejects.toThrow(
      "setDraftCard failed",
    );

    const done = await step("receive").run(created, live.ctx);
    const cards = live.posts("C0TRIAGE001");
    expect(cards).toHaveLength(1);
    const draftId = done.output!.draftId as string;
    expect((cards[0].blocks as { block_id: string }[])[0].block_id).toBe(
      `sylon:draft-card:${draftId}`,
    );
    expect(await getDraft(db, draftId)).toMatchObject({
      cardTs: "1790990000.000001",
    });
  });
});
