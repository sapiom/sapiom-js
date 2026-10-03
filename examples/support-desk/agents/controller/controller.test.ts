/** The controller on a local trace: real step code and SQL on pg-mem, Jev stubbed, no Slack. */
import { beforeEach, describe, expect, it } from "vitest";

import { setConfig } from "../../_shared/config";
import { localFleetDb, setLocalDb, type Db } from "../../_shared/db";
import { defaultDesk, upsertDesk } from "../../_shared/desks";
import {
  accountByChannel,
  createDraft,
  ensureAccount,
  linkMessage,
  openIssue,
  setStatus,
} from "../../_shared/issues";
import { fakeCtx } from "../../_shared/test-ctx";
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

async function runController(executionId: string, input: unknown = {}) {
  const c = ctxWithJev(executionId);
  const scanned = await step("scan").run(input, c.ctx);
  const done =
    scanned.kind === "terminate"
      ? scanned
      : await step("send").run(scanned.input, c.ctx);
  const posts = c.logs
    .filter((l) => l.msg.startsWith("slack chat.postMessage"))
    .map((l) => (l.data as { args: Record<string, unknown> }).args);
  return { ...c, scanned, done, posts };
}

describe("controller", () => {
  let db: Db;
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
        `no_owner:${waiting.id}`,
        `customer_waiting:${(await db.query<{ id: string }>("select id from messages where issue_id = $1", [waiting.id]))[0].id}`,
        `draft_pending:${(await db.query<{ id: string }>("select id from drafts where issue_id = $1", [waiting.id]))[0].id}`,
        `no_owner:${thanked.id}`,
        `no_draft:${thanked.id}`,
        `no_owner:${held.id}`,
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
    const scanned = await step("scan").run({}, c.ctx);
    // The copilot drafts after the scan queued no_draft.
    await createDraft(db, { issueId: issue.id, text: "Here is a fix." });
    const out = await step("send").run(scanned.input, c.ctx);
    expect(out.output!.resolved).toEqual([`no_draft:${issue.id}`]);
    expect((out.output!.nudged as { key: string }[]).map((n) => n.key)).toEqual(
      [`no_owner:${issue.id}`],
    );
    const recorded = await db.query<{ kind: string }>(
      "select kind from nudges where issue_id = $1",
      [issue.id],
    );
    expect(recorded.map((r) => r.kind)).toEqual([`no_owner:${issue.id}`]);
  });

  it("a retried send step posts nothing twice", async () => {
    await seedIssue(db, { title: "retry" });
    await backdate(db);
    const first = await runController("exec-1");
    expect(first.posts).toHaveLength(2);
    const retry = ctxWithJev("exec-1");
    const out = await step("send").run(first.scanned.input, retry.ctx);
    expect(out.output!.nudged).toEqual([]);
    expect(out.output!.notSent).toHaveLength(2);
    expect(retry.emitted).toHaveLength(0);
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
      const scanned = await step("scan").run({}, c.ctx);
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
        const scanned = await step("scan").run({}, c.ctx);
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
});
