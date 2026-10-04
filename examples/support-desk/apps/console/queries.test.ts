/** The Console's desk-scoped reads on pg-mem: each view shows one desk's issues and no other's. */
import { beforeEach, describe, expect, it } from "vitest";

import { memoryDb, type Db } from "../../_shared/db";
import { upsertDesk, type Desk } from "../../_shared/desks";
import {
  createDraft,
  linkMessage,
  logEvent,
  ensureAccount,
  openIssue,
  setStatus,
} from "../../_shared/issues";
import { createArticle, listArticles } from "../../_shared/kb";
import { resetBoard } from "../../_shared/reset";
import { fakeCtx } from "../../_shared/test-ctx";
import { scopeReceipts } from "./logic";
import {
  boardIssues,
  deskAccount,
  deskTicket,
  metricIssues,
  parseBoardFilter,
  receiptDesks,
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
    expect((await boardIssues(db, test.id)).map((r) => r.title)).toEqual([
      "test two",
      "test one",
    ]);
    expect((await boardIssues(db, support.id)).map((r) => r.title)).toEqual([
      "support one",
    ]);
  });

  it("shows open tickets by default and one status on a filter", async () => {
    await issueOn(test, "open one");
    const b = await issueOn(test, "closed one");
    await setStatus(db, b.id, "closed");
    const titles = async (f: Parameters<typeof boardIssues>[2]) =>
      (await boardIssues(db, test.id, f)).map((r) => r.title);
    expect(await titles("open")).toEqual(["open one"]);
    expect(await titles("closed")).toEqual(["closed one"]);
    expect(await titles("new")).toEqual(["open one"]);
    expect(parseBoardFilter(null)).toBe("open");
    expect(parseBoardFilter("on_hold")).toBe("on_hold");
    expect(parseBoardFilter("deleted")).toBeNull();
  });

  it("gives each row its newest draft status and the Linear state linear-sync recorded", async () => {
    const a = await issueOn(test, "a");
    const b = await issueOn(test, "b");
    await createDraft(db, { issueId: a.id, text: "first" });
    await db.query("update drafts set status = 'superseded'");
    await createDraft(db, { issueId: a.id, text: "second" });
    await logEvent(db, {
      type: "issue.engineering_resolved",
      payload: { issueId: a.id, linearState: "Done" },
      emittedBy: "linear-sync",
    });
    const rows = await boardIssues(db, test.id);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)).toMatchObject({
      draftStatus: "pending",
      linearState: "Done",
    });
    expect(byId.get(b.id)).toMatchObject({
      draftStatus: null,
      linearState: null,
    });
  });

  it("opens a ticket only on its own desk, with its pending draft", async () => {
    const a = await issueOn(test, "mine");
    const b = await issueOn(support, "theirs");
    const draft = await createDraft(db, {
      issueId: a.id,
      text: "Try again",
      cardChannel: "C0TESTTRI",
      cardTs: "1790200000.000100",
    });
    const t = await deskTicket(db, test.id, a.id);
    expect(t?.pendingDraft).toEqual({
      id: draft.id,
      text: "Try again",
      cardChannel: "C0TESTTRI",
      cardTs: "1790200000.000100",
    });
    expect(await deskTicket(db, test.id, b.id)).toBeNull();
    expect((await deskTicket(db, support.id, b.id))?.pendingDraft).toBeNull();
  });

  it("summarizes an account of the desk, and refuses another desk's", async () => {
    const a = await issueOn(test, "open");
    const b = await issueOn(test, "closed recently");
    const c = await issueOn(test, "closed long ago");
    await setStatus(db, b.id, "closed");
    await setStatus(db, c.id, "closed");
    await db.query(
      "update issues set closed_at = now() - interval '40 days' where id = $1",
      [c.id],
    );
    await linkMessage(db, {
      issueId: a.id,
      source: "slack",
      sourceEventId: "ev-1",
      direction: "customer",
      slack: { channel: "C0CUSTTEST", ts: "1790300000.000100" },
      userId: "U0CUST",
      text: "hello",
    });
    const view = await deskAccount(db, test.id, a.accountId);
    expect(view).toMatchObject({
      name: "Acct test",
      channelId: "C0CUSTTEST",
      open: 1,
      closedLast30Days: 1,
    });
    expect(view?.lastContactAt).toBeInstanceOf(Date);
    expect(view?.tickets.map((t) => t.title)).toEqual([
      "closed long ago",
      "closed recently",
      "open",
    ]);
    expect(await deskAccount(db, support.id, a.accountId)).toBeNull();
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
