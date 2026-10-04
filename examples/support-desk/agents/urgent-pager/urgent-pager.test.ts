/** urgent-pager on local traces: pages on urgent only, links the triage thread, pages once. */
import { beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/index";
import { setConfig } from "../../_shared/config";
import { localFleetDb, setLocalDb, type Db } from "../../_shared/db";
import { upsertDesk } from "../../_shared/desks";
import {
  accountByChannel,
  ensureAccount,
  messageBySourceEventId,
  openIssue,
  setTriageRoot,
} from "../../_shared/issues";
import { fakeCtx } from "../../_shared/test-ctx";
import { agent, pageKey } from "./index";

type Directive = { kind: string; output?: Record<string, unknown> };
const run = (input: unknown, ctx: unknown) =>
  (
    agent.steps.page as unknown as {
      run: (i: unknown, c: unknown) => Promise<Directive>;
    }
  ).run(input, ctx);

const urgent = () =>
  structuredClone(fixture("urgent-pager/created.urgent.json").payload);
const dms = (logs: { msg: string; data?: unknown }[]) =>
  logs
    .filter((l) => l.msg.startsWith("slack chat.postMessage"))
    .map((l) => (l.data as { args: { channel: string; text: string } }).args);

describe("urgent-pager", () => {
  let db: Db;
  beforeEach(async () => {
    db = await localFleetDb();
    setLocalDb(db);
  });

  it("ignores an issue that is not urgent", async () => {
    const { ctx, logs } = fakeCtx({ isLocalTrace: true });
    const done = await run(fixture("issue/created.json").payload, ctx);
    expect(done.output).toMatchObject({
      outcome: "not_urgent",
      priority: "normal",
    });
    expect(dms(logs)).toEqual([]);
  });

  it("DMs on-call the title and the triage thread, once", async () => {
    const account = (await accountByChannel(db, "C0CUSTOMER1"))!;
    const issue = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "urgent",
      title: "Production API returning 500s for every request",
      customer: { channel: "C0CUSTOMER1", ts: "1790889355.981329" },
    });
    await setTriageRoot(db, issue.id, "1790889360.000100");
    const input = { ...urgent(), issueId: issue.id };

    const first = fakeCtx({ isLocalTrace: true, executionId: "page-1" });
    expect((await run(input, first.ctx)).output).toMatchObject({
      outcome: "paged",
      oncall: "U0ONCALL001",
      link: "https://slack.com/archives/C0TRIAGE001/p1790889360000100",
    });
    const [dm] = dms(first.logs);
    expect(dm.channel).toBe("U0ONCALL001");
    expect(dm.text).toContain(`Urgent issue #${issue.number}: Production API`);
    expect(await messageBySourceEventId(db, pageKey(issue.id))).toMatchObject({
      issueId: null,
      direction: "internal",
    });

    const retry = fakeCtx({ isLocalTrace: true, executionId: "page-2" });
    expect((await run(input, retry.ctx)).output).toMatchObject({
      outcome: "already_paged",
    });
    expect(dms(retry.logs)).toEqual([]);
  });

  it("pages the issue's desk's on-call and links its desk's triage channel", async () => {
    const test = (
      await upsertDesk(db, {
        slug: "test",
        name: "Test",
        triageChannel: "C0TESTTRI01",
        oncallSlackId: "U0TESTONCALL",
      })
    ).desk;
    const account = await ensureAccount(db, {
      name: "Test co",
      slackChannelId: "C0TESTCUST1",
      deskId: test.id,
    });
    const issue = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "urgent",
      title: "Test desk outage",
      customer: { channel: "C0TESTCUST1", ts: "1790889355.981329" },
    });
    await setTriageRoot(db, issue.id, "1790889360.000100");
    const { ctx, logs } = fakeCtx({
      isLocalTrace: true,
      executionId: "page-d",
    });
    expect(
      (await run({ ...urgent(), issueId: issue.id }, ctx)).output,
    ).toMatchObject({
      outcome: "paged",
      oncall: "U0TESTONCALL",
      link: "https://slack.com/archives/C0TESTTRI01/p1790889360000100",
    });
    expect(dms(logs)[0].channel).toBe("U0TESTONCALL");
  });

  it("falls back to the global on-call when the desk has none, and fails when neither exists", async () => {
    const bare = (
      await upsertDesk(db, {
        slug: "bare",
        name: "Bare",
        triageChannel: "C0BARE",
      })
    ).desk;
    const account = await ensureAccount(db, {
      name: "Bare co",
      slackChannelId: "C0BARECUST",
      deskId: bare.id,
    });
    const issue = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "urgent",
      title: "Bare outage",
      customer: { channel: "C0BARECUST", ts: "1790889355.981329" },
    });
    const input = { ...urgent(), issueId: issue.id };
    await expect(
      run(input, fakeCtx({ isLocalTrace: true, executionId: "p-1" }).ctx),
    ).rejects.toThrow(/oncallSlackId/);
    await setConfig(db, "oncall.slack_id", "U0GLOBAL", "t");
    const { ctx, logs } = fakeCtx({ isLocalTrace: true, executionId: "p-2" });
    expect((await run(input, ctx)).output).toMatchObject({
      oncall: "U0GLOBAL",
    });
    expect(dms(logs)[0].channel).toBe("U0GLOBAL");
  });

  it("pages once when two runs for one issue overlap", async () => {
    const account = (await accountByChannel(db, "C0CUSTOMER1"))!;
    const issue = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "urgent",
      title: "Checkout down",
      customer: { channel: "C0CUSTOMER1", ts: "1790889355.981329" },
    });
    const input = { ...urgent(), issueId: issue.id };
    const a = fakeCtx({ isLocalTrace: true, executionId: "page-a" });
    const b = fakeCtx({ isLocalTrace: true, executionId: "page-b" });
    const outcomes = (
      await Promise.all([run(input, a.ctx), run(input, b.ctx)])
    ).map((d) => d.output?.outcome);
    expect(outcomes.sort()).toEqual(["already_paged", "paged"]);
    expect([...dms(a.logs), ...dms(b.logs)]).toHaveLength(1);
  });

  it("links the customer message when the issue is not in the database", async () => {
    const { ctx, logs } = fakeCtx({ isLocalTrace: true });
    const done = await run(urgent(), ctx);
    expect(done.output).toMatchObject({
      outcome: "paged",
      link: "https://slack.com/archives/C0CUSTOMER1/p1790889355981329",
    });
    expect(dms(logs)[0].text).not.toContain("#");
  });

  it("escapes Slack markup in the title", async () => {
    const { ctx, logs } = fakeCtx({ isLocalTrace: true });
    await run({ ...urgent(), title: "<!here> down *now*" }, ctx);
    expect(dms(logs)[0].text).not.toContain("<!here>");
  });
});
