/** The copilot on a local trace: real step code, the fixture world in pg-mem, no Slack, a stubbed LLM. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/index";
import { localFleetDb, setLocalDb, type Db } from "../../_shared/db";
import {
  createDraft,
  getDraft,
  getIssue,
  messageBySourceEventId,
  pendingDrafts,
  setStatus,
} from "../../_shared/issues";
import { KB } from "../../_shared/kb.generated";
import { fakeCtx } from "../../_shared/test-ctx";
import {
  copilotCard,
  normalizeOutput,
  outputSchema,
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
      citations: {
        causationId: "Ev0EXAMPLE01",
        confidence: 0.8,
        sources: ["webhooks"],
      },
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
      citations: {
        causationId: "Ev0EXAMPLE01",
        confidence: 0.5,
        sources: [],
        summary: "s",
      },
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

  it("an empty reply stores the summary but posts no card", async () => {
    const t = ctxFor("e", { ...DRAFTED, reply: "  " });
    const ds = await runAgent(fixture("issue/created.json").payload, t.ctx);
    expect(last(ds).output).toMatchObject({ skipped: "no reply needed" });
    expect(t.slack("chat.postMessage")).toHaveLength(0);
    expect(await pendingDrafts(db, FIXTURE_ISSUE)).toHaveLength(0);
    expect((await getIssue(db, FIXTURE_ISSUE)).summary).toBe(DRAFTED.summary);
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

  it("the output schema limits citations to kb slugs", () => {
    const schema = outputSchema(KB) as {
      properties: { citations: { items: { enum: string[] } } };
    };
    expect(schema.properties.citations.items.enum).toEqual(
      KB.map((p) => p.slug),
    );
  });
});
