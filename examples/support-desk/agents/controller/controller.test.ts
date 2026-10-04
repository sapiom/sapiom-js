/** The controller on a local trace: real step code and SQL on pg-mem, Jev stubbed, no Slack. */
import { beforeEach, describe, expect, it } from "vitest";

import { setConfig } from "../../_shared/config";
import { localFleetDb, setLocalDb, type Db } from "../../_shared/db";
import { defaultDesk, upsertDesk } from "../../_shared/desks";
import {
  accountByChannel,
  assign,
  createDraft,
  ensureAccount,
  getIssue,
  linkMessage,
  openIssue,
  setStatus,
  setTriageRoot,
  updateIssue,
} from "../../_shared/issues";
import { EXAMPLE_SLA, fakeCtx } from "../../_shared/test-ctx";
import { agent } from "./index";

type Directive = {
  kind: string;
  output?: Record<string, unknown>;
  target?: string;
  input?: unknown;
};
const step = (name: string) =>
  agent.steps[name] as unknown as {
    run: (i: unknown, c: unknown) => Promise<Directive>;
  };

let seq = 0;
async function seedIssue(
  db: Db,
  opts: {
    title: string;
    customerText?: string;
    pendingDraft?: boolean;
    status?: "on_hold";
  },
) {
  const account = (await accountByChannel(db, "C0CUSTOMER1"))!;
  const ts = `1790000${String(++seq).padStart(3, "0")}.000100`;
  const issue = await openIssue(db, {
    accountId: account.id,
    source: "slack",
    category: "question",
    priority: "normal",
    title: opts.title,
    customer: { channel: "C0CUSTOMER1", ts },
    triageRootTs: `1790100${String(seq).padStart(3, "0")}.000100`,
  });
  if (opts.customerText)
    await linkMessage(db, {
      issueId: issue.id,
      source: "slack",
      sourceEventId: `Ev${seq}`,
      direction: "customer",
      slack: { channel: "C0CUSTOMER1", ts },
      userId: "U0CUSTOMER1",
      text: opts.customerText,
    });
  if (opts.pendingDraft)
    await createDraft(db, { issueId: issue.id, text: "Try restarting it." });
  if (opts.status) await setStatus(db, issue.id, opts.status);
  return issue;
}

/** Test-only: age every row past the 5-minute threshold. */
async function backdate(db: Db) {
  const t = "now() - interval '10 minutes'";
  await db.query(`update issues set created_at = ${t}`);
  await db.query(`update messages set created_at = ${t}`);
  await db.query(`update drafts set created_at = ${t}`);
}

function ctxWithJev(executionId: string) {
  const fake = fakeCtx({ isLocalTrace: true, executionId });
  const asked: string[] = [];
  const ctx = {
    ...fake.ctx,
    sapiom: {
      ...(fake.ctx.sapiom as object),
      decisions: {
        async evaluate(spec: { state: { lastMessage: string } }) {
          asked.push(spec.state.lastMessage);
          const noul = /thanks/i.test(spec.state.lastMessage) ? 0.05 : 0.95;
          return { answers: { expects_reply: { type: "noul", noul } } };
        },
      },
    },
  };
  return { ...fake, ctx, asked };
}

let db: Db;

/** Every list a tick's output carries; {@link runController} concatenates them across tickets. */
const LISTS = [
  "nudged",
  "escalated",
  "unnotified",
  "notSent",
  "resolved",
  "skipped",
] as const;

/**
 * Fire every open ticket's timer once, in ticket order, in one context: what the per-ticket
 * schedules do when all of them come due. `scanned` and `done` merge the ticks' directives.
 */
async function runController(
  executionId: string,
  input: Record<string, unknown> = {},
) {
  const c = ctxWithJev(executionId);
  const open = await db.query<{ id: string }>(
    "select id from issues where status <> 'closed' order by number",
  );
  const scans: Directive[] = [];
  const dones: Directive[] = [];
  for (const { id } of open) {
    const scanned = await step("scan").run({ ...input, issueId: id }, c.ctx);
    scans.push(scanned);
    dones.push(
      scanned.kind === "terminate"
        ? scanned
        : await step("send").run(scanned.input, c.ctx),
    );
  }
  const merge = (ds: (Record<string, unknown> | undefined)[]) =>
    Object.fromEntries(
      LISTS.map((k) => [k, ds.flatMap((d) => (d?.[k] as unknown[]) ?? [])]),
    );
  const scanned = {
    kind: scans.every((s) => s.kind === "terminate") ? "terminate" : "continue",
    input: merge(
      scans.map((s) =>
        s.kind === "terminate"
          ? s.output
          : (s.input as Record<string, unknown>),
      ),
    ),
  };
  const done = {
    kind: "terminate",
    output: {
      ...merge(dones.map((d) => d.output)),
      jevCheck: (input.jevCheck as boolean | undefined) ?? true,
    },
  } as Directive;
  const posts = c.logs
    .filter((l) => l.msg.startsWith("slack chat.postMessage"))
    .map((l) => (l.data as { args: Record<string, unknown> }).args);
  return { ...c, scanned, done, posts };
}

describe("controller", () => {
  beforeEach(async () => {
    db = await localFleetDb();
    setLocalDb(db);
  });

  it("posts one nudge per due rule per issue, then nothing on the next run", async () => {
    const waiting = await seedIssue(db, {
      title: "waiting",
      customerText: "it is still broken",
      pendingDraft: true,
    });
    const thanked = await seedIssue(db, {
      title: "thanked",
      customerText: "thanks, that fixed it!",
    });
    const held = await seedIssue(db, {
      title: "held",
      customerText: "any news?",
      pendingDraft: true,
      status: "on_hold",
    });
    const fresh = await seedIssue(db, { title: "fresh" });
    await backdate(db);
    await db.query("update issues set created_at = now() where id = $1", [
      fresh.id,
    ]);

    const first = await runController("exec-1");
    const nudged = (first.done.output!.nudged as { key: string }[])
      .map((n) => n.key)
      .sort();
    expect(nudged).toEqual(
      [
        `no_owner:${waiting.id}:1`,
        `customer_waiting:${(await db.query<{ id: string }>("select id from messages where issue_id = $1", [waiting.id]))[0].id}:1`,
        `draft_pending:${(await db.query<{ id: string }>("select id from drafts where issue_id = $1", [waiting.id]))[0].id}:1`,
        `no_owner:${thanked.id}:1`,
        `no_draft:${thanked.id}:1`,
        `no_owner:${held.id}:1`,
      ].sort(),
    );
    // Every nudge is a reply in its issue's triage thread.
    expect(first.posts).toHaveLength(6);
    for (const p of first.posts) {
      expect(p.channel).toBe("C0TRIAGE001");
      expect(p.threadTs).toMatch(/^1790100/);
      // ... and links #n back to the ticket card (the thread root).
      expect(JSON.stringify(p.blocks)).toContain(
        `<https://slack.com/archives/C0TRIAGE001/p${String(p.threadTs).replace(".", "")}|#`,
      );
    }
    expect(
      first.posts
        .map((p) => (p.blocks as { block_id: string }[])[0].block_id)
        .sort(),
    ).toEqual(
      (first.done.output!.nudged as { issueId: string; key: string }[])
        .map((n) => `sylon:nudge:${n.issueId}:${n.key}`)
        .sort(),
    );
    expect(first.emitted.map((e) => e.type)).toEqual(
      Array(6).fill("issue.nudged"),
    );
    expect(first.emitted[0].id).toMatch(/^issue\.nudged:nudge:/);
    // Jev was asked about both customer_waiting candidates; the thank-you was skipped.
    expect(first.asked.sort()).toEqual(
      ["it is still broken", "thanks, that fixed it!"].sort(),
    );
    expect(first.scanned.input).toMatchObject({
      skipped: [{ issueId: thanked.id }],
    });

    const second = await runController("exec-2");
    expect(second.scanned.kind).toBe("terminate");
    expect(second.posts).toHaveLength(0);
    expect(second.emitted).toHaveLength(0);
    // The skip verdict is remembered, so Jev is not asked again.
    expect(second.asked).toEqual([]);
  });

  it("a new customer message re-arms customer_waiting", async () => {
    const issue = await seedIssue(db, {
      title: "rearm",
      customerText: "help",
      pendingDraft: true,
    });
    await backdate(db);
    await runController("exec-1");
    await linkMessage(db, {
      issueId: issue.id,
      source: "slack",
      sourceEventId: "EvRearm",
      direction: "customer",
      slack: { channel: "C0CUSTOMER1", ts: "1790999999.000100" },
      userId: "U0CUSTOMER1",
      text: "still there?",
    });
    await db.query(
      "update messages set created_at = now() - interval '6 minutes' where source_event_id = 'EvRearm'",
    );
    const again = await runController("exec-2");
    expect(
      (again.done.output!.nudged as { key: string }[]).map((n) => n.key),
    ).toEqual([expect.stringMatching(/^customer_waiting:/)]);
  });

  it("with jevCheck off, nudges the thank-you thread without asking Jev", async () => {
    await seedIssue(db, {
      title: "thanked",
      customerText: "thanks, that fixed it!",
      pendingDraft: true,
    });
    await backdate(db);
    const run = await runController("exec-1", { jevCheck: false });
    expect(run.asked).toEqual([]);
    expect(
      (run.done.output!.nudged as { key: string }[]).map(
        (n) => n.key.split(":")[0],
      ),
    ).toContain("customer_waiting");
  });

  it("drops a nudge whose condition resolved between scan and send", async () => {
    const issue = await seedIssue(db, { title: "drafted late" });
    await backdate(db);
    const c = ctxWithJev("exec-1");
    const scanned = await step("scan").run({ issueId: issue.id }, c.ctx);
    // The copilot drafts after the scan queued no_draft.
    await createDraft(db, { issueId: issue.id, text: "Here is a fix." });
    const out = await step("send").run(scanned.input, c.ctx);
    expect(out.output!.resolved).toEqual([`no_draft:${issue.id}:1`]);
    expect((out.output!.nudged as { key: string }[]).map((n) => n.key)).toEqual(
      [`no_owner:${issue.id}:1`],
    );
    const recorded = await db.query<{ kind: string }>(
      "select kind from nudges where issue_id = $1",
      [issue.id],
    );
    expect(recorded.map((r) => r.kind)).toEqual([`no_owner:${issue.id}:1`]);
  });

  it("a retried send step posts nothing twice", async () => {
    const issue = await seedIssue(db, { title: "retry" });
    await backdate(db);
    const c = ctxWithJev("exec-1");
    const scanned = await step("scan").run({ issueId: issue.id }, c.ctx);
    const first = await step("send").run(scanned.input, c.ctx);
    expect(first.output!.nudged).toHaveLength(2);
    const retry = ctxWithJev("exec-1");
    const out = await step("send").run(scanned.input, retry.ctx);
    expect(out.output!.nudged).toEqual([]);
    expect(out.output!.notSent).toHaveLength(2);
    expect(retry.emitted).toHaveLength(0);
  });

  it("repeats each held nudge after the gap, without asking Jev again", async () => {
    const waiting = await seedIssue(db, {
      title: "still waiting",
      customerText: "it is still broken",
      pendingDraft: true,
    });
    await backdate(db);
    const first = await runController("exec-1");
    const firstKeys = (first.done.output!.nudged as { key: string }[]).map(
      (n) => n.key,
    );
    expect(firstKeys).toHaveLength(3);
    expect(firstKeys.every((k) => k.endsWith(":1"))).toBe(true);
    expect(first.asked).toEqual(["it is still broken"]);

    const between = await runController("exec-2");
    expect(between.scanned.kind).toBe("terminate");
    expect(between.posts).toHaveLength(0);

    // Cross the repeat boundary without waiting for wall-clock time.
    await db.query(
      "update nudges set sent_at = now() - interval '61 minutes' where issue_id = $1",
      [waiting.id],
    );
    const second = await runController("exec-3");
    const secondKeys = (second.done.output!.nudged as { key: string }[])
      .map((n) => n.key)
      .sort();
    expect(secondKeys).toEqual(
      firstKeys.map((k) => k.replace(/:1$/, ":2")).sort(),
    );
    expect(second.asked).toEqual([]);
    expect(second.posts).toHaveLength(3);
    for (const p of second.posts) expect(p.threadTs).toBe(waiting.triageRootTs);
    expect(second.emitted.map((e) => e.type)).toEqual(
      Array(3).fill("issue.nudged"),
    );
    for (const e of second.emitted) expect(e.id).toMatch(/:2$/);
    expect(second.logs.find((l) => l.msg === "controller scan")?.data).toEqual({
      issueId: waiting.id,
      status: "new",
      due: 3,
      nudges: 3,
      escalations: 0,
      unnotified: [],
      skipped: [],
    });
    expect(second.done.output).toMatchObject({
      notSent: [],
      resolved: [],
      skipped: [],
      jevCheck: true,
    });
  });

  it("a Jev failure on round 1 does not stop a later no-reply verdict from silencing the repeats", async () => {
    const issue = await seedIssue(db, {
      title: "thanked while Jev was down",
      customerText: "thanks, that fixed it!",
      pendingDraft: true,
    });
    await backdate(db);
    const kinds = (out: Directive) =>
      (out.output!.nudged as { key: string }[])
        .map((n) => n.key.split(":")[0])
        .sort();
    const down = ctxWithJev("exec-1");
    down.ctx.sapiom.decisions.evaluate = async () => {
      throw new Error("jev unavailable");
    };
    const scanned = await step("scan").run({ issueId: issue.id }, down.ctx);
    const first = await step("send").run(scanned.input, down.ctx);
    expect(kinds(first)).toEqual([
      "customer_waiting",
      "draft_pending",
      "no_owner",
    ]);

    const age = (interval: string) =>
      db.query(
        `update nudges set sent_at = now() - interval '${interval}' where issue_id = $1`,
        [issue.id],
      );
    // Cross the repeat boundary without waiting for wall-clock time.
    await age("61 minutes");
    const second = await runController("exec-2");
    expect(second.asked).toEqual(["thanks, that fixed it!"]);
    expect(kinds(second.done)).toEqual(["draft_pending", "no_owner"]);

    await age("5 hours");
    const third = await runController("exec-3");
    expect(third.asked).toEqual([]);
    expect(kinds(third.done)).toEqual(["draft_pending", "no_owner"]);
  });

  it("with nudge.repeat_minutes set to [], nudges once", async () => {
    const issue = await seedIssue(db, { title: "once" });
    await setConfig(db, "nudge.repeat_minutes", [], "test");
    await backdate(db);
    await runController("exec-1");
    await db.query(
      "update nudges set sent_at = now() - interval '100 hours' where issue_id = $1",
      [issue.id],
    );
    const again = await runController("exec-2");
    expect(again.scanned.kind).toBe("terminate");
    expect(again.posts).toHaveLength(0);
  });

  it("with sla set, scan and send both use the priority's target", async () => {
    await setConfig(db, "sla", EXAMPLE_SLA, "test");
    const urgent = await seedIssue(db, { title: "urgent" });
    const normal = await seedIssue(db, { title: "normal" });
    await db.query("update issues set priority = 'urgent' where id = $1", [
      urgent.id,
    ]);
    // Owned, so only no_draft is left to nudge.
    await assign(db, urgent.id, "U0OWNER01");
    await assign(db, normal.id, "U0OWNER01");
    await db.query(
      "update issues set created_at = now() - interval '16 minutes'",
    );
    const r = await runController("exec-sla", { jevCheck: false });
    // Distinct priorities must remain distinct through both scan and send.
    expect(
      (r.done.output!.nudged as { key: string }[]).map((n) => n.key),
    ).toEqual([`no_draft:${urgent.id}:1`]);
    expect(r.done.output!.resolved).toEqual([]);
    expect(r.posts).toHaveLength(1);
  });

  describe("desks", () => {
    /** An open, unowned, undrafted issue on `deskId`, 10 minutes old. */
    async function aged(deskId: string, channel: string, n: number) {
      const account = await ensureAccount(db, {
        name: `Acme ${n}`,
        slackChannelId: channel,
        deskId,
      });
      const issue = await openIssue(db, {
        accountId: account.id,
        source: "slack",
        category: "question",
        priority: "normal",
        title: `desk issue ${n}`,
        customer: { channel, ts: `1790200${n}00.000100` },
        triageRootTs: `1790300${n}00.000100`,
      });
      await db.query(
        "update issues set created_at = now() - interval '10 minutes' where id = $1",
        [issue.id],
      );
      return issue;
    }

    it("applies each desk's nudge_minutes and nudges in that desk's triage channel", async () => {
      const support = (await defaultDesk(db))!;
      const slow = (
        await upsertDesk(db, {
          slug: "test",
          name: "Test",
          triageChannel: "C0TESTTRI01",
          nudgeMinutes: 60,
        })
      ).desk;
      const quick = (
        await upsertDesk(db, {
          slug: "vip",
          name: "VIP",
          triageChannel: "C0VIPTRI01",
          nudgeMinutes: 2,
        })
      ).desk;
      expect(support.nudgeMinutes).toBe(5);
      const onSupport = await aged(support.id, "C0SUPCUST01", 1);
      const onSlow = await aged(slow.id, "C0TESTCUST01", 2);
      const onQuick = await aged(quick.id, "C0VIPCUST01", 3);
      // Younger than the support desk's 5 minutes but older than the vip desk's 2.
      await db.query(
        "update issues set created_at = now() - interval '3 minutes' where id = $1",
        [onQuick.id],
      );

      const r = await runController("exec-desks", { jevCheck: false });
      const nudged = (r.done.output?.nudged as { issueId: string }[]).map(
        (n) => n.issueId,
      );
      expect(new Set(nudged)).toEqual(new Set([onSupport.id, onQuick.id]));
      expect(nudged).not.toContain(onSlow.id);
      const channels = r.posts.map((p) => [p.threadTs, p.channel]);
      expect(channels).toContainEqual([onSupport.triageRootTs, "C0TRIAGE001"]);
      expect(channels).toContainEqual([onQuick.triageRootTs, "C0VIPTRI01"]);
      expect(r.posts.some((p) => p.channel === "C0TESTTRI01")).toBe(false);
    });

    it("nudges under the card in the channel it was posted in after the desk's channel moves", async () => {
      const support = (await defaultDesk(db))!;
      const issue = await aged(support.id, "C0SUPCUST01", 4);
      await setTriageRoot(db, issue.id, "C0TRIAGE001", issue.triageRootTs!);
      await upsertDesk(
        db,
        { ...support, triageChannel: "C0NEW" },
        { overwrite: true },
      );

      const r = await runController("exec-moved", { jevCheck: false });
      expect(r.posts.length).toBeGreaterThan(0);
      for (const p of r.posts) {
        expect(p).toMatchObject({
          channel: "C0TRIAGE001",
          threadTs: issue.triageRootTs,
        });
        expect(JSON.stringify(p.blocks)).toContain("archives/C0TRIAGE001/");
        expect(JSON.stringify(p.blocks)).not.toContain("C0NEW");
      }
    });
  });

  describe("escalation", () => {
    const escalate = (entry: Record<string, unknown>) =>
      setConfig(
        db,
        "escalation",
        { support: { levels: [5, 60], ...entry } } as never,
        "test",
      );
    const ageTo = (interval: string) =>
      Promise.all(
        ["issues", "messages", "drafts"].map((t) =>
          db.query(
            `update ${t} set created_at = now() - interval '${interval}'`,
          ),
        ),
      );
    const dms = (r: { posts: Record<string, unknown>[] }) =>
      r.posts.filter((p) => String(p.channel).startsWith("U"));
    const threadPosts = (r: { posts: Record<string, unknown>[] }) =>
      r.posts.filter(
        (p) => /escalation \(level/.test(String(p.text)) && p.threadTs,
      );
    const escalated = (r: { done: Directive }) =>
      ((r.done.output?.escalated ?? []) as { key: string }[]).map((e) => e.key);
    const recorded = async (issueId: string) =>
      (
        await db.query<{ kind: string }>(
          "select kind from nudges where issue_id = $1 and kind like 'escalate:%' order by kind",
          [issueId],
        )
      ).map((r) => r.kind);

    it("DMs on-call and mentions the group in the triage thread, once per level", async () => {
      await escalate({ groupId: "S0SUPPORT1" });
      const issue = await seedIssue(db, { title: "stuck" });
      await backdate(db);

      const first = await runController("exec-1");
      expect(escalated(first)).toEqual(["escalate:1"]);
      expect(dms(first)).toHaveLength(1);
      const [dm] = dms(first);
      expect(dm.channel).toBe("U0ONCALL001");
      expect(dm.text).toContain("stuck");
      expect(dm.text).toContain("no owner for 10 min");
      expect(dm.text).toContain(
        `https://slack.com/archives/C0TRIAGE001/p${issue.triageRootTs!.replace(".", "")}`,
      );
      expect(threadPosts(first)).toHaveLength(1);
      const [thread] = threadPosts(first);
      expect(thread.channel).toBe("C0TRIAGE001");
      expect(thread.threadTs).toBe(issue.triageRootTs);
      expect(thread.text).toContain("<!subteam^S0SUPPORT1>");
      expect((thread.blocks as { block_id: string }[])[0].block_id).toBe(
        `sylon:nudge:${issue.id}:escalate:1`,
      );

      const second = await runController("exec-2");
      expect(dms(second)).toHaveLength(0);
      expect(threadPosts(second)).toHaveLength(0);

      await ageTo("2 hours");
      const third = await runController("exec-3");
      expect(escalated(third)).toEqual(["escalate:2"]);
      expect(dms(third)).toHaveLength(1);
      expect(threadPosts(third)).toHaveLength(1);
      const fourth = await runController("exec-4");
      expect(dms(fourth)).toHaveLength(0);
      expect(await recorded(issue.id)).toEqual(["escalate:1", "escalate:2"]);
    });

    it("after the desk's triage channel moves, links and threads under the card where it was posted", async () => {
      await escalate({ groupId: "S0SUPPORT1" });
      const issue = await seedIssue(db, { title: "moved" });
      await setTriageRoot(db, issue.id, "C0TRIAGE001", issue.triageRootTs!);
      const support = (await defaultDesk(db))!;
      await upsertDesk(
        db,
        { ...support, triageChannel: "C0NEW" },
        { overwrite: true },
      );
      await backdate(db);
      const r = await runController("exec-moved");
      expect(escalated(r)).toEqual(["escalate:1"]);
      expect(dms(r)[0].text).toContain(
        `https://slack.com/archives/C0TRIAGE001/p${issue.triageRootTs!.replace(".", "")}`,
      );
      expect(threadPosts(r)).toEqual([
        expect.objectContaining({
          channel: "C0TRIAGE001",
          threadTs: issue.triageRootTs,
        }),
      ]);
    });

    it("sends one escalation naming both conditions, aged from the oldest", async () => {
      await escalate({ groupId: "S0SUPPORT1" });
      const issue = await seedIssue(db, {
        title: "both",
        customerText: "it is still broken",
      });
      await backdate(db);
      await db.query(
        "update messages set created_at = now() - interval '2 minutes'",
      );
      const r = await runController("exec-1");
      expect(escalated(r)).toEqual(["escalate:1"]);
      expect(dms(r)).toHaveLength(1);
      expect(dms(r)[0].text).toContain(
        "no owner for 10 min, customer waiting for a reply for 2 min",
      );
      expect(threadPosts(r)).toHaveLength(1);
      expect(await recorded(issue.id)).toEqual(["escalate:1"]);
    });

    it("asks Jev once per message and drops a thank-you", async () => {
      await escalate({ groupId: "S0SUPPORT1" });
      const thanked = await seedIssue(db, {
        title: "thanked",
        customerText: "thanks, that fixed it!",
      });
      await seedIssue(db, { title: "waiting", customerText: "still broken" });
      await db.query("update issues set owner_slack_id = 'U0OWNER0001'");
      await backdate(db);
      const r = await runController("exec-1");
      // "still broken" is both a nudge and an escalation reason: one question.
      expect(r.asked.sort()).toEqual([
        "still broken",
        "thanks, that fixed it!",
      ]);
      expect(r.done.output?.escalated).toHaveLength(1);
      expect(await recorded(thanked.id)).toEqual([]);
      const [msg] = await db.query<{ id: string }>(
        "select id from messages where issue_id = $1",
        [thanked.id],
      );
      const skips = await db.query<{ kind: string }>(
        "select kind from nudges where issue_id = $1",
        [thanked.id],
      );
      expect(skips.map((k) => k.kind)).toContain(
        `skip:customer_waiting:${msg.id}`,
      );
    });

    it("without a group mentions on-call; an entry's on-call overrides the desk's", async () => {
      await escalate({ oncallSlackId: "U0OVERRIDE1" });
      await seedIssue(db, { title: "solo" });
      await backdate(db);
      const r = await runController("exec-1");
      expect(dms(r).map((p) => p.channel)).toEqual(["U0OVERRIDE1"]);
      expect(threadPosts(r)[0].text).toContain("<@U0OVERRIDE1>");
    });

    it("records nothing and never asks Jev again when there is nobody to notify", async () => {
      await escalate({});
      await db.query("update desks set oncall_slack_id = null");
      const issue = await seedIssue(db, {
        title: "nobody",
        customerText: "still broken",
      });
      await backdate(db);
      const first = await runController("exec-1");
      expect(dms(first)).toHaveLength(0);
      expect(threadPosts(first)).toHaveLength(0);
      expect(first.done.output?.unnotified).toEqual(["escalate:1"]);
      expect(await recorded(issue.id)).toEqual([]);
      // Unnotifiable escalations must not re-query Jev on every scan.
      expect(first.asked).toEqual(["still broken"]);
      const second = await runController("exec-2");
      expect(second.asked).toEqual([]);
      expect(second.done.output?.unnotified).toEqual(["escalate:1"]);
    });

    it("a delayed send never posts a lower level after a racing run sent a higher one", async () => {
      await escalate({ groupId: "S0SUPPORT1" });
      const issue = await seedIssue(db, {
        title: "race",
        customerText: "still broken",
      });
      await db.query(
        "update issues set created_at = now() - interval '59 minutes'",
      );
      await db.query(
        "update messages set created_at = now() - interval '8 minutes'",
      );
      const c = ctxWithJev("exec-1");
      const scanned = await step("scan").run({ issueId: issue.id }, c.ctx);
      expect(
        (scanned.input as { escalations: { key: string }[] }).escalations.map(
          (e) => e.key,
        ),
      ).toEqual(["escalate:1"]);
      // A higher sent level must suppress a delayed lower-level send even when another condition still holds.
      await db.query(
        "insert into nudges (issue_id, kind) values ($1, 'escalate:2')",
        [issue.id],
      );
      await db.query("update issues set owner_slack_id = 'U0OWNER0001'");
      const out = await step("send").run(scanned.input, c.ctx);
      expect(out.output!.escalated).toEqual([]);
      expect(await recorded(issue.id)).toEqual(["escalate:2"]);
    });

    it("jevCheck off overrides an earlier Jev skip for escalations too", async () => {
      await escalate({ groupId: "S0SUPPORT1" });
      await seedIssue(db, {
        title: "thanked",
        customerText: "thanks, that fixed it!",
      });
      await db.query("update issues set owner_slack_id = 'U0OWNER0001'");
      await backdate(db);
      expect(escalated(await runController("exec-1"))).toEqual([]);
      expect(
        escalated(await runController("exec-2", { jevCheck: false })),
      ).toEqual(["escalate:1"]);
    });

    it("a desk without an entry never escalates", async () => {
      await setConfig(db, "escalation", { vip: { levels: [1] } }, "test");
      await seedIssue(db, { title: "other desk" });
      await backdate(db);
      const r = await runController("exec-1");
      expect(dms(r)).toHaveLength(0);
      expect(escalated(r)).toEqual([]);
    });

    it.each([
      ["unowned", undefined],
      [
        "with a rejected thank-you as old as the level",
        "thanks, that fixed it!",
      ],
    ])(
      "drops an escalation when the issue is taken between scan and send (%s)",
      async (_, customerText) => {
        await escalate({ groupId: "S0SUPPORT1" });
        const issue = await seedIssue(db, { title: "taken", customerText });
        await backdate(db);
        const c = ctxWithJev("exec-1");
        const scanned = await step("scan").run({ issueId: issue.id }, c.ctx);
        expect(
          (scanned.input as { escalations: { key: string }[] }).escalations.map(
            (e) => e.key,
          ),
        ).toEqual(["escalate:1"]);
        await db.query("update issues set owner_slack_id = 'U0OWNER0001'");
        const out = await step("send").run(scanned.input, c.ctx);
        expect(out.output!.escalated).toEqual([]);
        expect(out.output!.resolved).toContain("escalate:1");
        expect(await recorded(issue.id)).toEqual([]);
      },
    );
  });

  describe("timers", () => {
    const tick = (issueId: string, executionId = "exec-tick") => {
      const c = ctxWithJev(executionId);
      return step("scan")
        .run({ issueId }, c.ctx)
        .then(async (scanned) => ({
          ...c,
          scanned,
          done:
            scanned.kind === "terminate"
              ? scanned
              : await step("send").run(scanned.input, c.ctx),
        }));
    };
    const timer = async (issueId: string) => {
      const i = await getIssue(db, issueId);
      return { id: i.nextTickId, at: i.nextTickAt };
    };

    it("sends what is due, then sets the timer for the next round", async () => {
      const issue = await seedIssue(db, { title: "late" });
      await backdate(db);
      const r = await tick(issue.id);
      expect(
        (r.done.output!.nudged as { key: string }[]).map((n) => n.key).sort(),
      ).toEqual([`no_draft:${issue.id}:1`, `no_owner:${issue.id}:1`]);
      const [{ sent_at }] = await db.query<{ sent_at: Date }>(
        "select min(sent_at) as sent_at from nudges where issue_id = $1",
        [issue.id],
      );
      // The second round comes after the first repeat gap, 60 minutes.
      const t = await timer(issue.id);
      expect(t.id).toMatch(/^local:/);
      expect(t.at!.getTime()).toBe(new Date(sent_at).getTime() + 60 * 60_000);
      expect(r.done.output!.timer).toMatchObject({
        issueId: issue.id,
        due: { reason: "nudge" },
      });
    });

    it("a tick with nothing due sends nothing and sets the timer at the first due time", async () => {
      const issue = await seedIssue(db, { title: "fresh" });
      const r = await tick(issue.id);
      expect(r.scanned.kind).toBe("terminate");
      expect(r.done.output!.nudged).toEqual([]);
      expect((await timer(issue.id)).at!.getTime()).toBe(
        (await getIssue(db, issue.id)).createdAt.getTime() + 5 * 60_000,
      );
    });

    it("a closed ticket's tick sends nothing and clears its timer", async () => {
      const issue = await seedIssue(db, { title: "closed" });
      await backdate(db);
      await tick(issue.id);
      await setStatus(db, issue.id, "closed");
      const r = await tick(issue.id, "exec-2");
      expect(r.done.output).toMatchObject({ skipped: "issue is closed" });
      expect(await timer(issue.id)).toEqual({ id: null, at: null });
    });

    it("while paused, a tick sends nothing and clears the timer", async () => {
      const issue = await seedIssue(db, { title: "paused" });
      await backdate(db);
      await setConfig(db, "controller.paused", true, "test");
      const r = await tick(issue.id);
      expect(r.done.output).toMatchObject({ skipped: "controller paused" });
      expect(r.emitted).toEqual([]);
      expect(await timer(issue.id)).toEqual({ id: null, at: null });
    });

    it("a pause between scan and send stops the send", async () => {
      const issue = await seedIssue(db, { title: "paused mid-run" });
      await backdate(db);
      const c = ctxWithJev("exec-mid");
      const scanned = await step("scan").run({ issueId: issue.id }, c.ctx);
      expect(scanned.kind).toBe("continue");
      await setConfig(db, "controller.paused", true, "test");
      const out = await step("send").run(scanned.input, c.ctx);
      expect(out.output).toMatchObject({ skipped: "controller paused" });
      expect(c.emitted).toEqual([]);
      expect(await timer(issue.id)).toEqual({ id: null, at: null });
    });

    it("a card whose redraw failed brings the controller back to redraw it", async () => {
      const issue = await seedIssue(db, { title: "dirty" });
      await assign(db, issue.id, "U0OWNER01");
      await createDraft(db, { issueId: issue.id, text: "Here." });
      await db.query("update issues set card_dirty = true where id = $1", [
        issue.id,
      ]);
      const r = await tick(issue.id);
      expect(
        r.logs.filter((l) => l.msg.startsWith("slack chat.update")),
      ).toHaveLength(1);
      expect((await getIssue(db, issue.id)).cardDirty).toBe(false);
    });

    it("a run without an issue id sends nothing and sets every open ticket's timer", async () => {
      const a = await seedIssue(db, { title: "a" });
      const b = await seedIssue(db, { title: "b" });
      await backdate(db);
      const c = ctxWithJev("exec-rearm");
      const out = await step("scan").run({}, c.ctx);
      expect(out.output).toEqual({
        rearmed: { armed: 2, cleared: 0, failed: [] },
      });
      expect(c.emitted).toEqual([]);
      expect((await timer(a.id)).id).toMatch(/^local:/);
      expect((await timer(b.id)).id).toMatch(/^local:/);
    });

    it("a tick for an unknown issue does nothing", async () => {
      const r = await tick("00000000-0000-4000-8000-000000000000");
      expect(r.done.output).toMatchObject({ skipped: "issue not found" });
    });

    describe("On Hold", () => {
      async function held() {
        const issue = await seedIssue(db, {
          title: "held",
          customerText: "any news?",
        });
        await assign(db, issue.id, "U0OWNER01");
        await createDraft(db, { issueId: issue.id, text: "Escalated." });
        await updateIssue(db, issue.id, {
          linearIssueId: "uuid-SAP-1",
          linearIdentifier: "SAP-1",
        });
        await setStatus(db, issue.id, "on_hold");
        return issue;
      }
      const linearReads = (r: { logs: { msg: string }[] }) =>
        r.logs.filter((l) => l.msg.startsWith("linear get_issue")).length;

      it("does not read Linear before the first backoff point, and waits for it", async () => {
        const issue = await held();
        const r = await tick(issue.id);
        expect(linearReads(r)).toBe(0);
        expect(r.done.output!.linear).toBeNull();
        const onHoldAt = (await getIssue(db, issue.id)).onHoldAt!;
        expect((await timer(issue.id)).at!.getTime()).toBe(
          onHoldAt.getTime() + 60 * 60_000,
        );
      });

      it("reads Linear when the check is due, then waits 4 h for the next", async () => {
        const issue = await held();
        await db.query(
          "update issues set on_hold_at = now() - interval '61 minutes' where id = $1",
          [issue.id],
        );
        const r = await tick(issue.id);
        expect(linearReads(r)).toBe(1);
        // The local trace's Linear stub answers Todo: still On Hold.
        expect(r.done.output!.linear).toMatchObject({
          linearIdentifier: "SAP-1",
          state: "Todo",
          resolution: null,
        });
        const after = await getIssue(db, issue.id);
        expect(after.status).toBe("on_hold");
        expect(after.linearState).toBe("Todo");
        expect(after.nextTickAt!.getTime()).toBe(
          after.onHoldAt!.getTime() + 5 * 60 * 60_000,
        );
        const again = await tick(issue.id, "exec-2");
        expect(linearReads(again)).toBe(0);
      });
    });
  });
});
