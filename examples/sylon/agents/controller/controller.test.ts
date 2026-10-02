/** The controller on a local trace: real step code and SQL on pg-mem, Jev stubbed, no Slack. */
import { beforeEach, describe, expect, it } from "vitest";

import { localFleetDb, setLocalDb, type Db } from "../../_shared/db";
import {
  accountByChannel,
  createDraft,
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
});
