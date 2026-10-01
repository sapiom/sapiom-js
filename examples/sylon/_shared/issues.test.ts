import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "./db";
import { memoryDb } from "./db";
import {
  IllegalTransitionError,
  ISSUE_STATUSES,
  TRANSITIONS,
  accountByChannel,
  assign,
  canTransition,
  createDraft,
  decideDraft,
  getIssue,
  issueByCustomerThread,
  issueByTriageRoot,
  linkMessage,
  openIssue,
  openIssuesForAccount,
  pendingDrafts,
  recordNudge,
  recordRun,
  setDraftCard,
  setStatus,
  setTriageRoot,
  updateIssue,
  upsertAccount,
  type IssueStatus,
} from "./issues";

const CUSTOMER = { channel: "C0C6YDCFJBS", ts: "1790889355.981329" };

async function seed(db: Db) {
  const account = await upsertAccount(db, {
    name: "Acme",
    slackChannelId: CUSTOMER.channel,
  });
  const issue = await openIssue(db, {
    accountId: account.id,
    source: "slack",
    category: "question",
    priority: "normal",
    title: "Inbound events",
    customer: CUSTOMER,
  });
  return { account, issue };
}

describe("status machine", () => {
  it("matches design.md", () => {
    const legal = (from: IssueStatus) =>
      ISSUE_STATUSES.filter((to) => to !== from && canTransition(from, to));
    expect(legal("new")).toEqual([
      "on_you",
      "on_customer",
      "on_hold",
      "closed",
    ]);
    expect(legal("on_you")).toEqual(["on_customer", "on_hold", "closed"]);
    expect(legal("on_customer")).toEqual(["on_you", "on_hold", "closed"]);
    expect(legal("on_hold")).toEqual(["on_you", "closed"]);
    expect(legal("closed")).toEqual(["on_you"]);
  });

  it("allows staying put, so retries are no-ops", () => {
    for (const s of ISSUE_STATUSES) expect(canTransition(s, s)).toBe(true);
  });

  it("every status reaches closed", () => {
    for (const s of ISSUE_STATUSES)
      if (s !== "closed") expect(TRANSITIONS[s]).toContain("closed");
  });
});

describe("issues.ts on a database", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
  });

  it("upserts an account by channel and finds it", async () => {
    const a = await upsertAccount(db, { name: "Acme", slackChannelId: "C1" });
    const b = await upsertAccount(db, {
      name: "Acme Corp",
      slackChannelId: "C1",
    });
    expect(b.id).toBe(a.id);
    expect((await accountByChannel(db, "C1"))?.name).toBe("Acme Corp");
    expect(await accountByChannel(db, "C2")).toBeNull();
  });

  it("opens a numbered issue in status new, keyed by its customer thread", async () => {
    const { account, issue } = await seed(db);
    expect(issue).toMatchObject({
      number: 1,
      status: "new",
      source: "slack",
      customerRootTs: CUSTOMER.ts,
    });
    expect(
      (await issueByCustomerThread(db, CUSTOMER.channel, CUSTOMER.ts))?.id,
    ).toBe(issue.id);
    expect(await openIssuesForAccount(db, account.id)).toHaveLength(1);
  });

  it("roots a reply's issue at the thread, not the reply", async () => {
    const { account } = await seed(db);
    const reply = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "high",
      title: "t",
      customer: { channel: CUSTOMER.channel, ts: "2.0", threadTs: "1.0" },
    });
    expect(reply.customerRootTs).toBe("1.0");
  });

  it("enforces the status machine and stamps closed_at", async () => {
    const { issue } = await seed(db);
    await expect(setStatus(db, issue.id, "on_you")).resolves.toMatchObject({
      status: "on_you",
    });
    const closed = await setStatus(db, issue.id, "closed");
    expect(closed.closedAt).toBeInstanceOf(Date);
    await expect(setStatus(db, issue.id, "on_hold")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    const reopened = await setStatus(db, issue.id, "on_you");
    expect(reopened.closedAt).toBeNull();
    expect((await getIssue(db, issue.id)).status).toBe("on_you");
  });

  it("assigns, roots the triage thread, and updates fields", async () => {
    const { issue } = await seed(db);
    await assign(db, issue.id, "U1");
    await setTriageRoot(db, issue.id, "9.9");
    await updateIssue(db, issue.id, {
      summary: "s",
      linearIdentifier: "SAP-1",
      linearIssueId: "uuid-1",
    });
    const found = await issueByTriageRoot(db, "9.9");
    expect(found).toMatchObject({
      ownerSlackId: "U1",
      summary: "s",
      linearIdentifier: "SAP-1",
      linearIssueId: "uuid-1",
    });
  });

  it("links a message once per source event id", async () => {
    const { issue } = await seed(db);
    const input = {
      issueId: issue.id,
      source: "slack" as const,
      sourceEventId: "Ev1",
      direction: "customer" as const,
      slack: CUSTOMER,
      userId: "U1",
      text: "hi",
      jev: { is_issue: 0.9 },
    };
    const first = await linkMessage(db, input);
    const second = await linkMessage(db, { ...input, text: "changed" });
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({
      duplicate: true,
      message: { id: first.message.id, text: "hi" },
    });
    expect(first.message.jev).toEqual({ is_issue: 0.9 });
  });

  it("decides a draft once; the second click changes nothing", async () => {
    const { issue } = await seed(db);
    const draft = await createDraft(db, {
      issueId: issue.id,
      text: "Hello",
      citations: ["kb/a.md"],
    });
    await setDraftCard(db, draft.id, { channel: "C0C67P6GQKE", ts: "5.5" });
    expect(await pendingDrafts(db, issue.id)).toHaveLength(1);
    const first = await decideDraft(db, draft.id, "approved", "U1");
    const second = await decideDraft(db, draft.id, "dismissed", "U2");
    expect(first).toMatchObject({
      changed: true,
      draft: { status: "approved", decidedBy: "U1", cardTs: "5.5" },
    });
    expect(second).toMatchObject({
      changed: false,
      draft: { status: "approved", decidedBy: "U1" },
    });
    expect(await pendingDrafts(db, issue.id)).toHaveLength(0);
  });

  it("records a nudge once per kind", async () => {
    const { issue } = await seed(db);
    expect(await recordNudge(db, issue.id, "no_owner")).toBe(true);
    expect(await recordNudge(db, issue.id, "no_owner")).toBe(false);
    expect(await recordNudge(db, issue.id, "no_draft")).toBe(true);
  });

  it("records a run once and fills in the issue later", async () => {
    const { issue } = await seed(db);
    await recordRun(db, { executionId: "e1" }, "smoke-ingest");
    await recordRun(db, { executionId: "e1" }, "smoke-ingest", issue.id);
    await recordRun(
      db,
      { executionId: "e1" },
      "smoke-ingest",
      "a1b2c3d4-0000-4000-8000-0000000000ff",
    );
    expect(
      await db.query("select execution_id, issue_id, agent from runs"),
    ).toEqual([
      { execution_id: "e1", issue_id: issue.id, agent: "smoke-ingest" },
    ]);
  });
});
