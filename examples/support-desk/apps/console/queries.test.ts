/** The Console's desk-scoped reads on pg-mem: each view shows one desk's issues and no other's. */
import { beforeEach, describe, expect, it } from "vitest";

import { memoryDb, type Db } from "../../_shared/db";
import { upsertDesk, type Desk } from "../../_shared/desks";
import {
  logEvent,
  ensureAccount,
  openIssue,
  setTriageRoot,
} from "../../_shared/issues";
import { createArticle, listArticles } from "../../_shared/kb";
import { resetBoard } from "../../_shared/reset";
import { fakeCtx } from "../../_shared/test-ctx";
import { scopeReceipts, triageCardUrl } from "./logic";
import {
  deskIssue,
  metricIssues,
  receiptDesks,
  recentIssues,
  statusCounts,
} from "./queries";

let db: Db;
let test: Desk;
let support: Desk;
let n = 0;

async function issueOn(desk: Desk, title: string) {
  const account = await ensureAccount(db, {
    name: `Acct ${desk.slug}`,
    slackChannelId: `C0CUST${desk.slug.toUpperCase()}`,
    deskId: desk.id,
  });
  return openIssue(db, {
    accountId: account.id,
    source: "slack",
    category: "bug",
    priority: "normal",
    title,
    customer: { channel: account.slackChannelId, ts: `17900000${++n}.000100` },
    triageRootTs: `17901000${n}.000100`,
  });
}

beforeEach(async () => {
  db = await memoryDb();
  test = (
    await upsertDesk(db, {
      slug: "test",
      name: "Test",
      triageChannel: "C0TESTTRI",
      isDefault: true,
    })
  ).desk;
  support = (
    await upsertDesk(db, {
      slug: "support",
      name: "Support",
      triageChannel: "C0SUPTRI",
    })
  ).desk;
});

describe("desk-scoped reads", () => {
  it("counts and lists only the desk's issues", async () => {
    await issueOn(test, "test one");
    await issueOn(test, "test two");
    await issueOn(support, "support one");
    expect(await statusCounts(db, test.id)).toEqual({ new: 2 });
    expect(await statusCounts(db, support.id)).toEqual({ new: 1 });
    expect((await recentIssues(db, test.id)).map((r) => r.title)).toEqual([
      "test two",
      "test one",
    ]);
    expect((await recentIssues(db, support.id)).map((r) => r.title)).toEqual([
      "support one",
    ]);
  });

  it("finds the desk's newest issue, and an issue number only on its own desk", async () => {
    const a = await issueOn(test, "test one");
    const b = await issueOn(support, "support one");
    expect((await deskIssue(db, test.id))?.id).toBe(a.id);
    expect((await deskIssue(db, support.id))?.id).toBe(b.id);
    expect((await deskIssue(db, test.id, a.number))?.id).toBe(a.id);
    expect(await deskIssue(db, test.id, b.number)).toBeUndefined();
  });

  it("limits metrics to the desk's issues in the window", async () => {
    const mine = await issueOn(test, "mine");
    await issueOn(support, "theirs");
    const old = await issueOn(test, "old");
    await db.query(
      "update issues set created_at = now() - interval '3 days' where id = $1",
      [old.id],
    );
    const rows = await metricIssues(
      db,
      test.id,
      Date.now() - 24 * 3600_000,
      50,
    );
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
  });

  it("attributes failed receipts to the issue's desk and keeps the unattributable ones", async () => {
    const a = await issueOn(test, "a");
    const b = await issueOn(support, "b");
    await logEvent(db, {
      type: "issue.created",
      payload: { issueId: a.id },
      emittedBy: "intake",
      receiptId: "11",
    });
    await logEvent(db, {
      type: "issue.created",
      payload: { issueId: b.id },
      emittedBy: "intake",
      receiptId: "12",
    });
    const owners = await receiptDesks(db, ["11", "12", "13"]);
    expect(owners.get("11")).toBe(test.id);
    expect(owners.get("12")).toBe(support.id);
    expect(owners.has("13")).toBe(false);
    const failed = [{ id: "11" }, { id: "12" }, { id: "13" }];
    expect(scopeReceipts(failed, owners, test.id).map((r) => r.id)).toEqual([
      "11",
      "13",
    ]);
  });
});

describe("desk-scoped writes", () => {
  it("reset board closes only the selected desk's open issues", async () => {
    const mine = await issueOn(test, "mine");
    const theirs = await issueOn(support, "theirs");
    const { ctx } = fakeCtx({ isLocalTrace: true });
    const out = await resetBoard(db, ctx, { deskId: test.id });
    expect(out.map((o) => o.issueId)).toEqual([mine.id]);
    expect(await statusCounts(db, test.id)).toEqual({ closed: 1 });
    expect(await statusCounts(db, support.id)).toEqual({ new: 1 });
    expect(theirs.deskId).toBe(support.id);
  });

  it("the Knowledge list for a desk holds its articles and the all-desks ones", async () => {
    const add = (title: string, deskId: string | null) =>
      createArticle(
        db,
        { kind: "answer", title, body: "b", deskId },
        "console",
      );
    await add("everyone", null);
    await add("test only", test.id);
    await add("support only", support.id);
    const titles = async (deskId: string) =>
      (await listArticles(db, { deskId })).map((a) => a.title).sort();
    expect(await titles(test.id)).toEqual(["everyone", "test only"]);
    expect(await titles(support.id)).toEqual(["everyone", "support only"]);
  });
});

describe("card links", () => {
  it("point at the channel a card was posted in after its desk's channel moves", async () => {
    const issue = await issueOn(test, "moved");
    await setTriageRoot(db, issue.id, "C0TESTTRI", issue.triageRootTs!);
    const moved = (
      await upsertDesk(
        db,
        { ...test, triageChannel: "C0NEWTRI" },
        { overwrite: true },
      )
    ).desk;
    const root = issue.triageRootTs!.replace(".", "");
    const [row] = await recentIssues(db, moved.id);
    expect(triageCardUrl(row, moved.triageChannel)).toBe(
      `https://slack.com/archives/C0TESTTRI/p${root}`,
    );
    const one = (await deskIssue(db, moved.id, issue.number))!;
    expect(triageCardUrl(one, moved.triageChannel)).toBe(
      `https://slack.com/archives/C0TESTTRI/p${root}`,
    );
    expect(triageCardUrl(one, moved.triageChannel, "17909999.000100")).toBe(
      `https://slack.com/archives/C0TESTTRI/p17909999000100?thread_ts=${issue.triageRootTs}&cid=C0TESTTRI`,
    );
  });

  it("read a database not yet migrated to 082 and fall back to the desk's channel", async () => {
    const old = await memoryDb({ through: "081_desk_triage_unique" });
    const [desk] = await old.query<{ id: string }>(
      "insert into desks (slug, name, triage_channel, is_default) values ('test', 'Test', 'C0TESTTRI', true) returning id",
    );
    const [account] = await old.query<{ id: string }>(
      "insert into accounts (name, slack_channel_id, desk_id) values ('Acme', 'C0ACME', $1) returning id",
      [desk.id],
    );
    await old.query(
      "insert into issues (account_id, desk_id, source, title, triage_root_ts) values ($1, $2, 'slack', 'old card', '17909000.000100')",
      [account.id, desk.id],
    );
    const [row] = await recentIssues(old, desk.id);
    expect(row).toMatchObject({ title: "old card", account: "Acme" });
    expect(row).not.toHaveProperty("triage_channel");
    expect(triageCardUrl(row, "C0TESTTRI")).toBe(
      "https://slack.com/archives/C0TESTTRI/p17909000000100",
    );
    const one = (await deskIssue(old, desk.id))!;
    expect(triageCardUrl(one, "C0TESTTRI")).toBe(
      "https://slack.com/archives/C0TESTTRI/p17909000000100",
    );
  });
});
