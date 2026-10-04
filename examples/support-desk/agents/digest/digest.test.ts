import { beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/index";
import { deleteConfig, setConfig } from "../../_shared/config";
import { localFleetDb, setLocalDb, type Db } from "../../_shared/db";
import { deskBySlug, upsertDesk, type Desk } from "../../_shared/desks";
import { agentSlug } from "../../_shared/fleet-id";
import {
  accountByChannel,
  assign,
  ensureAccount,
  linkMessage,
  openIssue,
  recordDigest,
  setStatus,
  setTriageRoot,
  type IssueStatus,
} from "../../_shared/issues";
import type { Sla, SlaMessage } from "../../_shared/sla";
import { EXAMPLE_SLA, fakeCtx } from "../../_shared/test-ctx";
import { WATCHED_SLUGS } from "../watchdog/logic";
import { agent, digest, TIME_ZONE } from "./index";
import {
  DEFAULT_SLA_HOURS,
  digestMessage,
  formatAge,
  localDay,
  slaHoursFor,
  type DigestIssue,
} from "./logic";

const HOUR = 3600_000;
const NOW = new Date("2026-10-05T16:00:00Z");
const DESK = { name: "Support", triageChannel: "C0TRIAGE001" };
const MIN = 60_000;
// Wall-clock targets keep the deadlines independent of the day of the week.
const WALL: Sla = {
  ...EXAMPLE_SLA,
  targets: {
    urgent: {
      firstResponseMinutes: 480,
      nextResponseMinutes: 60,
      businessHours: false,
    },
    high: {
      firstResponseMinutes: 120,
      nextResponseMinutes: 60,
      businessHours: false,
    },
    normal: {
      firstResponseMinutes: 120,
      nextResponseMinutes: 60,
      businessHours: false,
    },
    low: {
      firstResponseMinutes: 120,
      nextResponseMinutes: 60,
      businessHours: false,
    },
  },
};
const said = (
  direction: SlaMessage["direction"],
  minutesAgo: number,
): SlaMessage => ({
  direction,
  ts: null,
  createdAt: new Date(NOW.getTime() - minutesAgo * MIN),
});

let n = 0;
const issue = (over: Partial<DigestIssue> & { ageHours?: number } = {}) => {
  const { ageHours = 1, ...rest } = over;
  return {
    number: ++n,
    status: "new" as IssueStatus,
    priority: "normal",
    title: `Issue ${n}`,
    accountName: "Acme",
    ownerSlackId: null,
    triageRootTs: `1790000000.${String(n).padStart(6, "0")}`,
    triageChannel: null,
    createdAt: new Date(NOW.getTime() - ageHours * HOUR),
    ...rest,
  };
};

const message = (
  issues: DigestIssue[],
  owners: Map<string, string> = new Map(),
  sla: Sla | null = null,
) =>
  digestMessage({
    desk: DESK,
    issues,
    owners,
    now: NOW,
    day: "2026-10-05",
    ageHours: DEFAULT_SLA_HOURS,
    sla,
  });
const texts = (blocks: Record<string, unknown>[]) =>
  blocks.map((b) => (b.text as { text: string }).text);
const body = (blocks: Record<string, unknown>[]) =>
  texts(blocks).slice(1).join("\n");

describe("sla and age", () => {
  it("reads the hours of the priority, unknown or missing ones as normal", () => {
    expect(slaHoursFor("urgent", DEFAULT_SLA_HOURS)).toBe(4);
    expect(slaHoursFor("high", DEFAULT_SLA_HOURS)).toBe(24);
    expect(slaHoursFor("low", DEFAULT_SLA_HOURS)).toBe(168);
    expect(slaHoursFor("critical", DEFAULT_SLA_HOURS)).toBe(72);
    expect(slaHoursFor("constructor", DEFAULT_SLA_HOURS)).toBe(72);
    expect(slaHoursFor(null, DEFAULT_SLA_HOURS)).toBe(72);
  });

  it("formats the age in days and hours, or hours and minutes under a day", () => {
    expect(formatAge((3 * 24 + 4) * HOUR + 59 * 60_000)).toBe("3d 4h");
    expect(formatAge(5 * HOUR + 12 * 60_000)).toBe("5h 12m");
    expect(formatAge(-1000)).toBe("0h 0m");
  });

  it("dates a run in the schedule's zone, not in UTC", () => {
    expect(TIME_ZONE).toBe("America/Los_Angeles");
    // 18:00 Pacific on July 1 is already July 2 in UTC.
    expect(localDay(new Date("2026-07-02T01:00:00Z"), TIME_ZONE)).toBe(
      "2026-07-01",
    );
    expect(localDay(new Date("2026-07-01T16:00:00Z"), TIME_ZONE)).toBe(
      "2026-07-01",
    );
    expect(localDay(new Date("2026-01-15T07:59:00Z"), TIME_ZONE)).toBe(
      "2026-01-14",
    );
  });
});

describe("digest message with sla set", () => {
  const flagged = (i: DigestIssue) =>
    body(message([i], new Map(), WALL).blocks).includes("*past SLA*");

  it("flags a breached first response and counts it in the header", () => {
    const late = issue({ ageHours: 3 });
    const out = message([late], new Map(), WALL);
    expect(texts(out.blocks)[0]).toContain("1 open, 1 past SLA");
    expect(body(out.blocks)).toContain("*past SLA*");
  });

  it("does not flag an issue older than its age limit whose first response is still ahead", () => {
    // Put the issue between the age cutoff and response target so the test distinguishes the two modes.
    const i = issue({ priority: "urgent", ageHours: 5 });
    expect(body(message([i]).blocks)).toContain("*past SLA*");
    expect(flagged(i)).toBe(false);
  });

  it("does not flag an issue where the team spoke last, whatever its age", () => {
    const i = issue({
      ageHours: 500,
      messages: [said("customer", 500 * 60), said("agent", 400 * 60)],
    });
    expect(flagged(i)).toBe(false);
  });

  it("flags a customer reply left past its next-response target, not one minute before", () => {
    const thread = [said("customer", 300), said("agent", 200)];
    expect(
      flagged(
        issue({ ageHours: 5, messages: [...thread, said("customer", 60)] }),
      ),
    ).toBe(true);
    expect(
      flagged(
        issue({ ageHours: 5, messages: [...thread, said("customer", 59)] }),
      ),
    ).toBe(false);
  });

  it("never flags On Hold, which the age rule does flag", () => {
    const held = issue({ status: "on_hold", ageHours: 500 });
    expect(body(message([held]).blocks)).toContain("*past SLA*");
    expect(flagged(held)).toBe(false);
  });

  it("ignores internal notes, which do not stop the first-response clock", () => {
    expect(
      flagged(issue({ ageHours: 3, messages: [said("internal", 30)] })),
    ).toBe(true);
  });

  it("flags at the exact due time, as the board shows breached", () => {
    expect(flagged(issue({ ageHours: 2 }))).toBe(true);
    expect(flagged(issue({ ageHours: 2 - 1 / 60 }))).toBe(false);
  });
});

describe("digest message", () => {
  it("groups open issues by status in board order and leaves Closed out", () => {
    const out = message([
      issue({ status: "on_hold", title: "held" }),
      issue({ status: "closed", title: "gone" }),
      issue({ status: "new", title: "fresh" }),
      issue({ status: "on_customer", title: "waiting" }),
    ]);
    const [header, ...rest] = texts(out.blocks);
    expect(header).toBe(
      "*Daily digest · Support · 2026-10-05*\n3 open, 0 past SLA",
    );
    expect(rest.map((t) => t.split("\n")[0])).toEqual([
      "*New (1)*",
      "*On Customer (1)*",
      "*On Hold (1)*",
    ]);
    expect(body(out.blocks)).not.toContain("gone");
    expect(out.text).toBe("Daily digest for Support: 3 open, 0 past SLA");
  });

  it("writes number, account, title, age, owner name and the card link", () => {
    const a = issue({
      ageHours: 5,
      ownerSlackId: "U1",
      triageRootTs: "1790000000.123456",
    });
    const b = issue({ ageHours: 2, title: null, triageRootTs: null });
    const c = issue({ ageHours: 1, ownerSlackId: "U9" });
    const lines = body(
      message([a, b, c], new Map([["U1", "Ada"]])).blocks,
    ).split("\n");
    expect(lines[1]).toBe(
      `<https://slack.com/archives/C0TRIAGE001/p1790000000123456|#${a.number}> Acme: Issue ${a.number} · 5h 0m · Ada`,
    );
    expect(lines[2]).toBe(`#${b.number} Acme: (untitled) · 2h 0m · unassigned`);
    // An owner whose name could not be read shows as the id, never as a mention.
    expect(lines[3]).toContain("· U9");
    expect(lines.join("\n")).not.toContain("<@");
  });

  it("escapes account and title, and cuts the title to 100 characters", () => {
    const out = body(
      message([
        issue({ accountName: "A & <B>", title: "a <b> & c" }),
        issue({ title: "x".repeat(150) }),
      ]).blocks,
    );
    expect(out).toContain("A &amp; &lt;B&gt;: a &lt;b&gt; &amp; c");
    expect(out).toContain(`: ${"x".repeat(100)} ·`);
    expect(out).not.toContain("x".repeat(101));
  });

  it("keeps the alerts of an issue whose account name is very long", () => {
    const out = body(
      message([issue({ accountName: "&".repeat(3100), ageHours: 500 })]).blocks,
    );
    expect(out).toContain(`${"&amp;".repeat(100)}: `);
    expect(out).not.toContain("&amp;".repeat(101));
    expect(out).toMatch(/· unassigned · \*past SLA\*$/);
  });

  it("flags past SLA in every open status, lists those first, then oldest first", () => {
    const young = issue({ priority: "normal", ageHours: 10 });
    const old = issue({ priority: "normal", ageHours: 20 });
    const late = issue({ priority: "urgent", ageHours: 4 });
    const held = issue({ status: "on_hold", priority: "low", ageHours: 200 });
    const odd = issue({ priority: "weird", ageHours: 80 });
    const out = message([young, old, late, held, odd]);
    const lines = body(out.blocks).split("\n");
    expect(texts(out.blocks)[0]).toContain("5 open, 3 past SLA");
    const order = lines
      .filter((l) => l.includes("Acme"))
      .map((l) => Number(/#(\d+)/.exec(l)![1]));
    expect(order).toEqual([
      odd.number,
      late.number,
      old.number,
      young.number,
      held.number,
    ]);
    const line = (i: DigestIssue) =>
      lines.find((l) => l.includes(`|#${i.number}>`))!;
    expect(line(late)).toContain("*past SLA*");
    expect(line(held)).toContain("*past SLA*");
    expect(line(odd)).toContain("*past SLA*");
    expect(line(old)).not.toContain("past SLA");
  });

  it("says so when the desk has no open issues", () => {
    const out = message([issue({ status: "closed" })]);
    expect(texts(out.blocks)).toEqual([
      "*Daily digest · Support · 2026-10-05*\nNo open issues.",
    ]);
  });

  it("lists 30 issues in full", () => {
    const out = message(Array.from({ length: 30 }, () => issue()));
    expect(body(out.blocks).match(/Acme/g)).toHaveLength(30);
    expect(body(out.blocks)).not.toContain("more open issues");
  });

  it("keeps 1500 issues within Slack's limits, with an exact +k more and every past-SLA issue", () => {
    const issues = Array.from({ length: 1500 }, (_, i) =>
      issue({
        status: (["new", "on_you", "on_customer", "on_hold"] as const)[i % 4],
        // Put overdue issues last to catch truncation that follows input order.
        ageHours: i >= 1460 ? 500 : 1,
        title: "y".repeat(80),
      }),
    );
    const out = message(issues);
    expect(out.blocks.length).toBeLessThanOrEqual(50);
    for (const t of texts(out.blocks))
      expect(t.length).toBeLessThanOrEqual(3000);
    const listed = body(out.blocks).match(/\|#\d+>/g)!.length;
    const last = texts(out.blocks).at(-1)!;
    expect(last).toBe(`+${1500 - listed} more open issues, see the Console`);
    expect(body(out.blocks).match(/past SLA/g)).toHaveLength(40);
    // Guard against severe underfilling of the available message capacity.
    expect(listed).toBeGreaterThan(600);
  });
});

type Call = { method: string; args: Record<string, unknown> };

function slackCtx(opts: { failPostsTo?: string } = {}) {
  const calls: Call[] = [];
  let ts = 0;
  const slack = {
    async postMessage(args: Record<string, unknown>) {
      calls.push({ method: "postMessage", args });
      if (args.channel === opts.failPostsTo)
        throw Object.assign(new Error("boom"), {
          status: 404,
          body: { error: "channel_not_found" },
        });
      return { ok: true, channel: args.channel, ts: `1791000000.00${++ts}` };
    },
    async userInfo(args: { user: string }) {
      calls.push({ method: "userInfo", args });
      if (args.user === "U0GONE") throw new Error("user_not_found");
      return {
        ok: true,
        user: {
          id: args.user,
          name: "x",
          profile: { display_name: `Name ${args.user}` },
        },
      };
    },
  };
  const out = fakeCtx({ isLocalTrace: false });
  (out.ctx as { sapiom: unknown }).sapiom = { connectors: { slack } };
  const posts = () => calls.filter((c) => c.method === "postMessage");
  return { ...out, calls, posts };
}

describe("digest run", () => {
  let db: Db;
  let support: Desk;
  let billing: Desk;

  const open = async (
    channel: string,
    title: string,
    over: { deskId?: string | null; status?: IssueStatus; owner?: string } = {},
  ) => {
    const account = (await accountByChannel(db, channel))!;
    const i = await openIssue(db, {
      accountId: account.id,
      deskId: over.deskId,
      source: "slack",
      category: "question",
      priority: "normal",
      title,
      customer: { channel, ts: `17900${++n}.000100` },
      triageRootTs: `17901${n}.000100`,
    });
    if (over.status === "closed") await setStatus(db, i.id, "closed");
    if (over.owner) await assign(db, i.id, over.owner);
    return i;
  };
  const textOf = (c: Call) =>
    (c.args.blocks as { text: { text: string } }[])
      .map((b) => b.text.text)
      .join("\n");

  beforeEach(async () => {
    db = await localFleetDb();
    support = (await deskBySlug(db, "support"))!;
    billing = (
      await upsertDesk(db, {
        slug: "billing",
        name: "Billing",
        triageChannel: "C0TRIAGE002",
      })
    ).desk;
    await ensureAccount(db, {
      name: "Payer",
      slackChannelId: "C0CUSTOMER2",
      deskId: billing.id,
    });
    await open("C0CUSTOMER1", "support one", { owner: "U0ADA" });
    await open("C0CUSTOMER1", "support orphan", { deskId: null });
    await open("C0CUSTOMER1", "support done", { status: "closed" });
    await open("C0CUSTOMER2", "billing one", { owner: "U0GONE" });
  });

  it("after a desk's triage channel moves, posts in the new channel and links each card where it was posted", async () => {
    const moved = await open("C0CUSTOMER1", "moved card");
    await setTriageRoot(db, moved.id, "C0TRIAGE001", moved.triageRootTs!);
    await upsertDesk(
      db,
      { ...support, triageChannel: "C0NEW" },
      { overwrite: true },
    );
    const { ctx, posts } = slackCtx();
    await digest(ctx as never, db);
    const post = posts().find((p) => p.args.channel === "C0NEW")!;
    const ts = moved.triageRootTs!.replace(".", "");
    expect(textOf(post)).toContain(
      `<https://slack.com/archives/C0TRIAGE001/p${ts}|#${moved.number}>`,
    );
  });

  it("posts each desk's own issues in its own triage channel, desk-less issues on the default desk", async () => {
    const { ctx, posts, calls, logs } = slackCtx();
    const out = await digest(ctx as never, db);
    expect(out.posted).toEqual(["support", "billing"]);
    expect(posts().map((p) => p.args.channel)).toEqual([
      "C0TRIAGE001",
      "C0TRIAGE002",
    ]);
    const [s, b] = posts().map(textOf);
    expect(s).toContain("support one");
    expect(s).toContain("support orphan");
    expect(s).toContain("Name U0ADA");
    expect(s).not.toContain("support done");
    expect(s).not.toContain("billing");
    expect(b).toContain("billing one");
    expect(b).toContain("· U0GONE");
    expect(b).not.toContain("support");
    expect(calls.filter((c) => c.method === "userInfo")).toHaveLength(2);
    expect(logs).toContainEqual({
      level: "info",
      msg: "digest",
      data: {
        day: out.day,
        posted: ["support", "billing"],
        skipped: [],
        failed: [],
      },
    });
  });

  it("treats an evening rerun as the same day as the morning post", async () => {
    const morning = new Date("2026-07-01T16:00:00Z");
    const evening = new Date("2026-07-02T01:00:00Z");
    const nextMorning = new Date("2026-07-02T16:00:00Z");
    await digest(slackCtx().ctx as never, db, morning);
    const rerun = slackCtx();
    expect(await digest(rerun.ctx as never, db, evening)).toMatchObject({
      day: "2026-07-01",
      posted: [],
    });
    expect(rerun.posts()).toHaveLength(0);
    const next = slackCtx();
    expect(await digest(next.ctx as never, db, nextMorning)).toMatchObject({
      day: "2026-07-02",
      posted: ["support", "billing"],
    });
  });

  it("posts once per desk per day, and again the next day", async () => {
    await digest(slackCtx().ctx as never, db);
    const again = slackCtx();
    const out = await digest(again.ctx as never, db);
    expect(out).toMatchObject({ posted: [], skipped: ["support", "billing"] });
    expect(again.posts()).toHaveLength(0);

    const tomorrow = slackCtx();
    const next = await digest(
      tomorrow.ctx as never,
      db,
      new Date(Date.now() + 24 * HOUR),
    );
    expect(next.posted).toEqual(["support", "billing"]);
    expect(tomorrow.posts()).toHaveLength(2);
  });

  it("fails the run on a failed post, keeps no row for that desk, and a rerun posts it", async () => {
    const broken = slackCtx({ failPostsTo: "C0TRIAGE002" });
    await expect(digest(broken.ctx as never, db)).rejects.toThrow(
      /digest not posted for billing .*channel_not_found/,
    );
    expect(broken.posts()).toHaveLength(2);
    expect(
      await db.query("select desk_id from digests order by desk_id"),
    ).toEqual([{ desk_id: support.id }]);

    const rerun = slackCtx();
    const out = await digest(rerun.ctx as never, db);
    expect(out).toMatchObject({ posted: ["billing"], skipped: ["support"] });
    expect(rerun.posts().map((p) => p.args.channel)).toEqual(["C0TRIAGE002"]);
  });

  it("merges a stored SLA over the defaults, and refuses an invalid one before posting", async () => {
    await db.query("update issues set created_at = now() - interval '2 hours'");
    await setConfig(db, "digest.sla_hours", { normal: 1 }, "test");
    const { ctx, posts } = slackCtx();
    await digest(ctx as never, db);
    expect(textOf(posts()[0])).toContain("2 open, 2 past SLA");

    const fresh = await localFleetDb();
    await fresh.query(
      "insert into config (key, value, set_by) values ('digest.sla_hours', '{\"normal\": \"soon\"}'::jsonb, 'test')",
    );
    const bad = slackCtx();
    await expect(digest(bad.ctx as never, fresh)).rejects.toThrow();
    expect(bad.posts()).toHaveLength(0);
    expect(await fresh.query("select * from digests")).toEqual([]);
  });

  const teamReplies = async (issueId: string) =>
    linkMessage(db, {
      issueId,
      source: "slack",
      sourceEventId: `Ev${++n}`,
      direction: "agent",
      slack: { channel: "C0CUSTOMER1", ts: `17902${n}.000100` },
      userId: "U0ADA",
      text: "on it",
    });
  const openIds = async (deskId: string) =>
    (
      await db.query<{ id: string }>(
        "select id from issues where status <> 'closed' and (desk_id = $1 or desk_id is null)",
        [deskId],
      )
    ).map((r) => r.id);
  // The run reads through each transaction's `tx`, so the spy wraps it there.
  const spyQueries = () => {
    const seen: { text: string; params?: unknown[] }[] = [];
    const transaction = db.transaction.bind(db);
    db.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          query: (text, params) => {
            seen.push({ text, params });
            return tx.query(text, params);
          },
        }),
      );
    return () => seen.filter((q) => /from messages/.test(q.text));
  };

  it("with sla set, skips issues where the team spoke last, and flags by age again once it is removed", async () => {
    await db.query("update issues set created_at = now() - interval '2 hours'");
    await setConfig(db, "digest.sla_hours", { normal: 1 }, "test");
    await setConfig(db, "sla", WALL, "test");
    for (const id of await openIds(support.id)) await teamReplies(id);
    const first = slackCtx();
    await digest(first.ctx as never, db);
    expect(textOf(first.posts()[0])).toContain("2 open, 0 past SLA");

    await deleteConfig(db, "sla");
    const next = slackCtx();
    await digest(next.ctx as never, db, new Date(Date.now() + 24 * HOUR));
    expect(textOf(next.posts()[0])).toContain("2 open, 2 past SLA");
  });

  it("with sla set, flags a breached first response in its own desk, loading each desk's messages in one query", async () => {
    await db.query("update issues set created_at = now() - interval '3 hours'");
    await setConfig(db, "sla", WALL, "test");
    const supportIds = await openIds(support.id);
    for (const id of supportIds) await teamReplies(id);
    const billingIds = (
      await db.query<{ id: string }>(
        "select id from issues where desk_id = $1",
        [billing.id],
      )
    ).map((r) => r.id);
    const messageQueries = spyQueries();
    const { ctx, posts } = slackCtx();
    await digest(ctx as never, db);
    const [s, b] = posts().map(textOf);
    expect(s).toContain("2 open, 0 past SLA");
    expect(b).toContain("1 open, 1 past SLA");
    expect(b).toMatch(/billing one .*\*past SLA\*/);
    expect(
      messageQueries().map((q) => (q.params![0] as string[]).sort()),
    ).toEqual([supportIds.sort(), billingIds]);
    expect(messageQueries()[0].text).toMatch(/direction <> 'internal'/);

    await deleteConfig(db, "sla");
    const before = messageQueries().length;
    await digest(slackCtx().ctx as never, db, new Date(Date.now() + 24 * HOUR));
    expect(messageQueries()).toHaveLength(before);
  });

  it("refuses an invalid stored sla before posting", async () => {
    await db.query(
      "insert into config (key, value, set_by) values ('sla', '{\"targets\": {}}'::jsonb, 'test')",
    );
    const bad = slackCtx();
    await expect(digest(bad.ctx as never, db)).rejects.toThrow();
    expect(bad.posts()).toHaveLength(0);
    expect(await db.query("select * from digests")).toEqual([]);
  });

  it("claims a desk and day once", async () => {
    expect(await recordDigest(db, support.id, "2026-10-05")).toBe(true);
    expect(await recordDigest(db, support.id, "2026-10-05")).toBe(false);
    expect(await recordDigest(db, support.id, "2026-10-06")).toBe(true);
  });
});

describe("digest agent", () => {
  beforeEach(() => setLocalDb(undefined));

  it("runs on the cron fixture on a local trace", async () => {
    const { ctx } = fakeCtx({ isLocalTrace: true });
    const step = agent.steps.post as unknown as {
      run: (i: unknown, c: unknown) => Promise<{ output?: unknown }>;
    };
    const done = await step.run(fixture("digest/cron.json").payload, ctx);
    expect(done.output).toMatchObject({ posted: ["support"], skipped: [] });
  });

  it("is watched by the watchdog", () => {
    expect(WATCHED_SLUGS).toContain(agentSlug("digest"));
  });
});
