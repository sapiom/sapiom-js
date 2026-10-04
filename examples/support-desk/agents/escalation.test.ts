/** The escalation agent: local traces on the fixtures, and the live code path against a mocked relay. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixture } from "../fixtures/index";
import { setConfig } from "../_shared/config";
import { localFleetDb, setLocalDb, withDb, type Db } from "../_shared/db";
import { upsertDesk } from "../_shared/desks";
import {
  accountByChannel,
  ensureAccount,
  getIssue,
  linkMessage,
  messageBySourceEventId,
  messagesForIssue,
  openIssue,
  setStatus,
  updateIssue,
} from "../_shared/issues";
import { LinearRelayError } from "../_shared/linear";
import { fakeCtx } from "../_shared/test-ctx";
import {
  LINEAR_PRIORITY,
  agent,
  CUSTOMER_REPLY,
  customerReplyKey,
  escalate,
  linearDescription,
  marker,
  type EscalateInput,
} from "./escalation/index";
import { FLEET_ID, agentSlug } from "../_shared/fleet-id";

type Directive = { kind: string; output?: Record<string, unknown> };
const run = (input: unknown, ctx: unknown) =>
  (
    agent.steps.escalate as unknown as {
      run: (i: unknown, c: unknown) => Promise<Directive>;
    }
  ).run(input, ctx);

const DIR = path.dirname(fileURLToPath(import.meta.url));
const local = (file: string) =>
  JSON.parse(
    readFileSync(path.join(DIR, "../fixtures/escalation", file), "utf8"),
  ) as { payload: EscalateInput };

const escalateFixture = () =>
  structuredClone(fixture("issue/escalate.json").payload) as EscalateInput;

describe("escalation on a local trace", () => {
  beforeEach(() => setLocalDb(undefined));

  it("links one Linear issue, replies in both threads, emits issue.on_hold, and parks the issue", async () => {
    const { ctx, emitted, logs } = fakeCtx({
      isLocalTrace: true,
      executionId: "esc-1",
    });
    const done = await run(escalateFixture(), ctx);
    expect(done.kind).toBe("terminate");
    expect(done.output).toMatchObject({
      outcome: "escalated",
      made: "created",
      linearIdentifier: "LOCAL-1",
      status: "on_hold",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "issue.on_hold",
      id: "issue.on_hold:1790889700.1004",
      payload: { linearIdentifier: "LOCAL-1" },
    });
    const posts = logs.filter((l) =>
      l.msg.startsWith("slack chat.postMessage"),
    );
    expect(
      posts.map((p) => (p.data as { args: { text: string } }).args.text),
    ).toEqual([
      "Tracked as LOCAL-1: https://linear.app/local/issue/LOCAL-1",
      CUSTOMER_REPLY,
    ]);

    const issueId = done.output!.issueId as string;
    await withDb(ctx as never, async (db) => {
      const reply = await messageBySourceEventId(db, customerReplyKey(issueId));
      expect(reply).toMatchObject({ issueId, direction: "agent" });
    });

    // A second escalation of the same issue (a new causation): nothing created, nothing emitted.
    const again = await run(
      { ...escalateFixture(), causationId: "1790889999.9999" },
      ctx,
    );
    expect(again.output).toMatchObject({
      outcome: "already_escalated",
      made: "existing",
      linearIdentifier: "LOCAL-1",
    });
    expect(emitted).toHaveLength(1);
    expect(
      logs.filter((l) => l.msg.startsWith("linear save_issue")),
    ).toHaveLength(1);
  });

  it("replies with the existing identifier for an already-linked issue", async () => {
    const { ctx, emitted, logs } = fakeCtx({
      isLocalTrace: true,
      executionId: "esc-already",
    });
    const done = await run(local("escalate.already-linked.json").payload, ctx);
    expect(done.output).toMatchObject({
      outcome: "already_escalated",
      linearIdentifier: "LOCAL-7",
      status: "on_hold",
    });
    expect(emitted).toHaveLength(0);
    expect(logs.some((l) => l.msg.startsWith("linear save_issue"))).toBe(false);
  });

  it("does not escalate a closed issue: one triage line, no Linear, no emit", async () => {
    const { ctx, emitted, logs } = fakeCtx({
      isLocalTrace: true,
      executionId: "esc-closed",
    });
    const done = await run(local("escalate.closed.json").payload, ctx);
    expect(done.output).toMatchObject({
      outcome: "not_escalated",
      status: "closed",
      skipped: "issue is closed",
    });
    expect(done.output).not.toHaveProperty("linearIdentifier");
    expect(emitted).toHaveLength(0);
    expect(logs.some((l) => l.msg.startsWith("linear save_issue"))).toBe(false);
    const posts = logs.filter((l) =>
      l.msg.startsWith("slack chat.postMessage"),
    );
    expect(
      posts.map((p) => (p.data as { args: { text: string } }).args.text),
    ).toEqual([
      expect.stringMatching(/^Not escalated: issue #\d+ is closed\.$/),
    ]);
  });
});

describe("escalation against the relay (mocked fetch)", () => {
  let db: Db;
  let issueId: string;
  let calls: { tool?: string; method: string; args: Record<string, unknown> }[];
  let found: Record<string, unknown>[];
  let linearDown: boolean;
  /** What get_issue reports for the issue already linked, when a test links one first. */
  let existingState: Record<string, string>;

  beforeEach(async () => {
    vi.stubEnv("SAPIOM_API_KEY", "sat_test");
    db = await localFleetDb();
    const account = (await accountByChannel(db, "C0CUSTOMER1"))!;
    const issue = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "urgent",
      title: "Inbound events fail",
      customer: { channel: "C0CUSTOMER1", ts: "1790889355.981329" },
      triageRootTs: "1790889356.000100",
    });
    issueId = issue.id;
    calls = [];
    found = [];
    linearDown = false;
    existingState = {};
    let ts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (url.includes("/connectors/v1/linear/mcp")) {
          if (linearDown)
            return new Response('{"message":"connector not connected"}', {
              status: 409,
            });
          const name = body.params.name as string;
          calls.push({
            tool: name,
            method: "mcp",
            args: body.params.arguments,
          });
          // Let a concurrent run reach its lock while this one is inside Linear.
          await new Promise((r) => setTimeout(r, 5));
          const result =
            name === "list_issues"
              ? { issues: found }
              : name === "get_issue" &&
                  body.params.arguments.id === "uuid-SAP-5"
                ? {
                    id: "SAP-5",
                    uuid: "uuid-SAP-5",
                    url: "https://linear.app/x/issue/SAP-5",
                    ...existingState,
                  }
                : {
                    id: "SAP-900",
                    uuid: "u-900",
                    url: "https://linear.app/x/issue/SAP-900",
                  };
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }],
              },
            }),
          );
        }
        const method = url.split("/methods/")[1];
        calls.push({ method, args: body });
        if (method === "users.info")
          return new Response(
            JSON.stringify({
              user: { id: body.user, profile: { display_name: "Dana" } },
            }),
          );
        return new Response(
          JSON.stringify({ channel: body.channel, ts: `1790900000.00${++ts}` }),
        );
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const input = (causationId = "1790889700.1004"): EscalateInput => ({
    ...escalateFixture(),
    issueId,
    causationId,
  });
  const liveCtx = () => fakeCtx({ isLocalTrace: false });

  it("creates the Linear issue with the configured team, project, priority, marker and permalink", async () => {
    const { ctx, emitted } = liveCtx();
    const out = await escalate(ctx as never, db, input());
    expect(out).toMatchObject({
      outcome: "escalated",
      made: "created",
      linearIdentifier: "SAP-900",
      url: "https://linear.app/x/issue/SAP-900",
    });
    const save = calls.find((c) => c.tool === "save_issue")!;
    expect(save.args).toMatchObject({
      team: "example-linear-team-id",
      project: "example-linear-project-id",
      title: "Inbound events fail",
      priority: LINEAR_PRIORITY.urgent,
      links: [
        {
          url: "https://slack.com/archives/C0CUSTOMER1/p1790889355981329",
          title: "Customer thread (Slack)",
        },
      ],
    });
    expect(save.args.description).toContain(marker(issueId));
    expect(save.args.description).toContain("Example Customer");
    expect(save.args.description).toContain(
      "Inbound events fail after retry; customer blocked.",
    );
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    expect(posts.map((p) => [p.args.channel, p.args.threadTs])).toEqual([
      ["C0TRIAGE001", "1790889356.000100"],
      ["C0CUSTOMER1", "1790889355.981329"],
    ]);
    expect(posts[0].args.text).toBe(
      "Tracked as SAP-900: https://linear.app/x/issue/SAP-900",
    );
    expect(posts[1].args.text).toBe(CUSTOMER_REPLY);
    expect(posts[1].args.text).not.toMatch(/linear\.app|SAP-\d+/);
    expect(save.args.description).toContain(
      "**Requested by:** Dana (U0TEAMMATE1)",
    );
    expect(emitted.map((e) => e.type)).toEqual(["issue.on_hold"]);
    expect(await getIssue(db, issueId)).toMatchObject({
      status: "on_hold",
      linearIssueId: "u-900",
      linearIdentifier: "SAP-900",
      linearUrl: "https://linear.app/x/issue/SAP-900",
    });
    // Both replies belong to the issue, so copilot and controller see them.
    expect(
      (await messagesForIssue(db, issueId)).map((m) => [
        m.sourceEventId,
        m.direction,
      ]),
    ).toEqual([
      [`escalation:${issueId}:triage`, "internal"],
      [customerReplyKey(issueId), "agent"],
    ]);
    // The triage card is redrawn from the updated row.
    const card = calls.find((c) => c.method === "chat.update")!;
    expect(card.args).toMatchObject({
      channel: "C0TRIAGE001",
      ts: "1790889356.000100",
    });
    expect(card.args.text).toContain("[On Hold]");
    expect(JSON.stringify(card.args.blocks)).toContain(
      "*Linear:* <https://linear.app/x/issue/SAP-900|SAP-900>",
    );
  });

  /** An issue on a second desk, with that desk's own triage channel and (optionally) Linear target. */
  async function issueOnDesk(linear: { team?: string; project?: string }) {
    const desk = (
      await upsertDesk(db, {
        slug: "test",
        name: "Test",
        triageChannel: "C0TESTTRI01",
        linearTeamId: linear.team,
        linearProjectId: linear.project,
      })
    ).desk;
    const account = await ensureAccount(db, {
      name: "Test co",
      slackChannelId: "C0TESTCUST1",
      deskId: desk.id,
    });
    return openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "high",
      title: "Test desk issue",
      customer: { channel: "C0TESTCUST1", ts: "1790889365.981329" },
      triageRootTs: "1790889366.000100",
    });
  }

  it("files the issue in its desk's Linear team and project and replies in its desk's triage channel", async () => {
    const issue = await issueOnDesk({
      team: "test-team",
      project: "test-proj",
    });
    const { ctx } = liveCtx();
    await escalate(ctx as never, db, { ...input(), issueId: issue.id });
    const save = calls.find((c) => c.tool === "save_issue")!;
    expect(save.args).toMatchObject({
      team: "test-team",
      project: "test-proj",
    });
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    expect(posts[0].args).toMatchObject({
      channel: "C0TESTTRI01",
      threadTs: "1790889366.000100",
    });
    expect(calls.find((c) => c.method === "chat.update")?.args).toMatchObject({
      channel: "C0TESTTRI01",
    });
  });

  it("falls back to the global Linear keys only when the desk names none", async () => {
    await setConfig(db, "linear.team_id", "global-team", "t");
    await setConfig(db, "linear.project_id", "global-proj", "t");
    const issue = await issueOnDesk({});
    await escalate(liveCtx().ctx as never, db, {
      ...input(),
      issueId: issue.id,
    });
    expect(calls.find((c) => c.tool === "save_issue")!.args).toMatchObject({
      team: "global-team",
      project: "global-proj",
    });
  });

  it("fails before touching Linear when neither the desk nor the config names a target", async () => {
    const issue = await issueOnDesk({});
    await expect(
      escalate(liveCtx().ctx as never, db, { ...input(), issueId: issue.id }),
    ).rejects.toThrow(/not set/);
    expect(calls.filter((c) => c.tool === "save_issue")).toHaveLength(0);
  });

  it("two concurrent runs create one Linear issue, one reply per thread, and one emit", async () => {
    const a = liveCtx();
    const b = liveCtx();
    const [x, y] = await Promise.all([
      escalate(a.ctx as never, db, input("ev-a")),
      escalate(b.ctx as never, db, input("ev-b")),
    ]);
    expect(calls.filter((c) => c.tool === "save_issue")).toHaveLength(1);
    expect([x.made, y.made].sort()).toEqual(["created", "existing"]);
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    expect(posts.map((p) => p.args.channel)).toEqual([
      "C0TRIAGE001",
      "C0CUSTOMER1",
    ]);
    expect([...a.emitted, ...b.emitted].map((e) => e.type)).toEqual([
      "issue.on_hold",
    ]);
    expect([x.outcome, y.outcome].sort()).toEqual([
      "already_escalated",
      "escalated",
    ]);
  });

  it("a retry after Linear created the issue but before the DB write adopts it", async () => {
    found = [
      { id: "SAP-1", uuid: "u-1", description: "unrelated" },
      {
        id: "SAP-900",
        uuid: "u-900",
        url: "https://linear.app/x/issue/SAP-900",
        description: `Support desk issue #1 · ${marker(issueId)}\n\n…`,
      },
    ];
    const { ctx } = liveCtx();
    const out = await escalate(ctx as never, db, input());
    expect(out).toMatchObject({
      made: "adopted",
      linearIdentifier: "SAP-900",
      url: "https://linear.app/x/issue/SAP-900",
    });
    expect(calls.some((c) => c.tool === "save_issue")).toBe(false);
    expect(calls.find((c) => c.tool === "list_issues")!.args).toMatchObject({
      project: "example-linear-project-id",
      createdAt: "-P7D",
    });
  });

  it("with Linear disconnected the run fails and nothing is half-written", async () => {
    linearDown = true;
    const { ctx, emitted } = liveCtx();
    await expect(escalate(ctx as never, db, input())).rejects.toBeInstanceOf(
      LinearRelayError,
    );
    expect(await getIssue(db, issueId)).toMatchObject({
      status: "new",
      linearIssueId: null,
      linearIdentifier: null,
    });
    expect(await messagesForIssue(db, issueId)).toEqual([]);
    expect(
      calls.filter((c) =>
        ["chat.postMessage", "chat.update"].includes(c.method),
      ),
    ).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("a failed emit rolls back the move to On Hold; the retry does both and posts no second reply", async () => {
    const { ctx, emitted } = liveCtx();
    const events = (ctx.sapiom as { events: { emit: (s: never) => unknown } })
      .events;
    const realEmit = events.emit;
    events.emit = async () => {
      throw new Error("events api down");
    };
    await expect(escalate(ctx as never, db, input())).rejects.toThrow(
      "events api down",
    );
    // Link and replies committed in the first transaction; the status move did not.
    expect(await getIssue(db, issueId)).toMatchObject({
      status: "new",
      linearIdentifier: "SAP-900",
    });
    events.emit = realEmit;
    const out = await escalate(ctx as never, db, input());
    expect(out).toMatchObject({ outcome: "escalated", status: "on_hold" });
    expect(emitted.map((e) => e.id)).toEqual(["issue.on_hold:1790889700.1004"]);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(
      2,
    );
  });

  it("a deployed run for an unknown issue id fails before touching Linear or Slack", async () => {
    const { ctx, emitted } = liveCtx();
    await expect(
      escalate(ctx as never, db, {
        ...input(),
        issueId: "a1b2c3d4-0000-4000-8000-0000000000ff",
      }),
    ).rejects.toThrow(/not found/);
    expect(calls.filter((c) => c.method !== "users.info")).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("a closed issue is not escalated: no Linear call, one triage line, nothing else", async () => {
    await setStatus(db, issueId, "closed");
    const { number } = await getIssue(db, issueId);
    const { ctx, emitted } = liveCtx();
    const out = await escalate(ctx as never, db, input());
    expect(out).toEqual({
      issueId,
      outcome: "not_escalated",
      status: "closed",
      skipped: "issue is closed",
    });
    expect(emitted).toEqual([]);
    expect(calls.filter((c) => c.method === "mcp")).toEqual([]);
    expect(calls.filter((c) => c.method === "chat.update")).toEqual([]);
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    expect(posts.map((p) => p.args)).toEqual([
      expect.objectContaining({
        channel: "C0TRIAGE001",
        threadTs: "1790889356.000100",
        text: `Not escalated: issue #${number} is closed.`,
      }),
    ]);
    expect(
      await messageBySourceEventId(db, `escalation:${issueId}:1790889700.1004`),
    ).toMatchObject({ direction: "internal" });
    expect(await getIssue(db, issueId)).toMatchObject({
      status: "closed",
      linearIssueId: null,
      linearIdentifier: null,
      linearUrl: null,
    });

    // The same causation again posts nothing.
    await escalate(ctx as never, db, input());
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(
      1,
    );
  });

  it("a closed issue linked to a Done Linear issue opens no new one", async () => {
    await updateIssue(db, issueId, {
      linearIssueId: "uuid-SAP-5",
      linearIdentifier: "SAP-5",
      linearUrl: "https://linear.app/x/issue/SAP-5",
    });
    await setStatus(db, issueId, "closed");
    existingState = { status: "Done", statusType: "completed" };
    const { ctx, emitted } = liveCtx();
    const out = await escalate(ctx as never, db, input());
    expect(out).toMatchObject({ outcome: "not_escalated", status: "closed" });
    expect(emitted).toEqual([]);
    expect(calls.filter((c) => c.tool === "save_issue")).toEqual([]);
    expect(calls.filter((c) => c.tool === "get_issue")).toEqual([]);
    expect((await getIssue(db, issueId)).linearIdentifier).toBe("SAP-5");
  });

  it("a repeat escalation whose Linear issue is already Done opens a new Linear issue and replies in both threads", async () => {
    await updateIssue(db, issueId, {
      linearIssueId: "uuid-SAP-5",
      linearIdentifier: "SAP-5",
      linearUrl: "https://linear.app/x/issue/SAP-5",
    });
    existingState = { status: "Done", statusType: "completed" };
    const first = liveCtx();
    // First escalation: replies recorded under the bare keys for SAP-5.
    await linkMessage(db, {
      issueId,
      source: "slack",
      sourceEventId: customerReplyKey(issueId),
      direction: "agent",
      slack: { channel: "C0CUSTOMER1", ts: "1790889400.1" },
      userId: agentSlug("escalation"),
      text: "Tracked as SAP-5: https://linear.app/x/issue/SAP-5",
    });
    const { ctx, emitted } = first;
    const out = await escalate(ctx as never, db, input());
    expect(out).toMatchObject({
      outcome: "escalated",
      linearIdentifier: "SAP-900",
      made: "created",
    });
    expect(calls.filter((c) => c.tool === "save_issue")).toHaveLength(1);
    const issue = await getIssue(db, issueId);
    expect(issue.linearIdentifier).toBe("SAP-900");
    expect(issue.status).toBe("on_hold");
    expect(
      calls
        .filter((c) => c.method === "chat.postMessage")
        .map((c) => c.args.text),
    ).toEqual([
      "Tracked as SAP-900: https://linear.app/x/issue/SAP-900",
      CUSTOMER_REPLY,
    ]);
    expect(emitted).toHaveLength(1);
  });

  it("a repeat escalation after the first replies (triage tracked, customer neutral) gets fresh keys", async () => {
    await updateIssue(db, issueId, {
      linearIssueId: "uuid-SAP-5",
      linearIdentifier: "SAP-5",
      linearUrl: "https://linear.app/x/issue/SAP-5",
    });
    existingState = { status: "Done", statusType: "completed" };
    const { ctx } = liveCtx();
    for (const [key, direction, text, ts] of [
      [
        `${customerReplyKey(issueId)}:triage`,
        "internal",
        "Tracked as SAP-5: https://linear.app/x/issue/SAP-5",
        "1790889400.2",
      ],
      [customerReplyKey(issueId), "agent", CUSTOMER_REPLY, "1790889400.1"],
    ] as const)
      await linkMessage(db, {
        issueId,
        source: "slack",
        sourceEventId: key,
        direction,
        slack: { channel: "C0CUSTOMER1", ts },
        userId: agentSlug("escalation"),
        text,
      });
    const out = await escalate(ctx as never, db, input());
    expect(out).toMatchObject({ outcome: "escalated", made: "created" });
    const texts = calls
      .filter((c) => c.method === "chat.postMessage")
      .map((c) => c.args.text);
    expect(texts).toEqual([
      "Tracked as SAP-900: https://linear.app/x/issue/SAP-900",
      CUSTOMER_REPLY,
    ]);
    expect(
      await messageBySourceEventId(db, `${customerReplyKey(issueId)}:SAP-900`),
    ).toMatchObject({ text: CUSTOMER_REPLY });
  });
});

describe("linearDescription", () => {
  it("holds the account, summary, permalink and marker", () => {
    const text = linearDescription({
      issue: { id: "i-1", number: 7 } as never,
      accountName: "Acme",
      summary: "Webhooks drop.",
      requestedBy: { id: "U1", name: "Dana" },
      threadUrl: "https://slack.com/archives/C1/p1",
    });
    expect(text).toContain("**Account:** Acme");
    expect(text).toContain("**Requested by:** Dana (U1)");
    expect(text).toContain(
      "[Customer thread in Slack](https://slack.com/archives/C1/p1)",
    );
    expect(text).toContain(`${FLEET_ID}:i-1`);
  });
});
