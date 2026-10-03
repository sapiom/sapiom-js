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
    const scanned = await step("scan").run({}, down.ctx);
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
});
