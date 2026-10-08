/** Per-ticket timers against pg-mem, with a fake schedules client in place of the Sapiom API. */
import { beforeEach, describe, expect, it } from "vitest";

import { getConfigOr, setConfig } from "./config";
import { localFleetDb, type Db } from "./db";
import { agentSlug } from "./fleet-id";
import {
  accountByChannel,
  assign,
  createDraft,
  getIssue,
  openIssue,
  setStatus,
  updateIssue,
} from "./issues";
import { issueSla } from "./sla";
import { EXAMPLE_SLA, fakeCtx } from "./test-ctx";
import {
  MIN_LEAD_MS,
  STUCK_RETRY_MINUTES,
  nextDue,
  rescheduleIssue,
  rescheduleOpen,
} from "./timers";

let db: Db;
let seq = 0;

async function seed(minutesOld = 0) {
  const account = (await accountByChannel(db, "C0CUSTOMER1"))!;
  const n = ++seq;
  const issue = await openIssue(db, {
    accountId: account.id,
    source: "slack",
    category: "question",
    priority: "normal",
    title: `timer ${n}`,
    customer: { channel: "C0CUSTOMER1", ts: `1790000${n}00.000100` },
    triageRootTs: `1790100${n}00.000100`,
  });
  if (minutesOld)
    await db.query(
      `update issues set created_at = now() - interval '${minutesOld} minutes' where id = $1`,
      [issue.id],
    );
  return getIssue(db, issue.id);
}

const dbNow = async () =>
  new Date(
    (await db.query<{ now: Date }>("select now() as now"))[0].now,
  ).getTime();

describe("rescheduleIssue", () => {
  beforeEach(async () => {
    db = await localFleetDb();
  });

  it("schedules the controller at the first due nudge, with the issue id as input", async () => {
    const issue = await seed();
    const { ctx, schedules } = fakeCtx();
    const out = await rescheduleIssue(db, ctx as never, issue.id);
    // The support desk nudges after 5 minutes (fleet.json).
    expect(out.due).toMatchObject({ reason: "nudge" });
    expect(out.at!.getTime()).toBe(issue.createdAt.getTime() + 5 * 60_000);
    expect(schedules.calls).toEqual([
      {
        op: "create",
        id: "sched-1",
        at: out.at!.toISOString(),
        input: { issueId: issue.id },
        definition: agentSlug("controller"),
      },
    ]);
    expect(await getIssue(db, issue.id)).toMatchObject({
      nextTickId: "sched-1",
      nextTickAt: out.at,
    });
  });

  it("keeps the stored schedule when the due time has not moved", async () => {
    const issue = await seed();
    const { ctx, schedules } = fakeCtx();
    await rescheduleIssue(db, ctx as never, issue.id);
    const again = await rescheduleIssue(db, ctx as never, issue.id);
    expect(again.changed).toBe(false);
    expect(schedules.calls).toHaveLength(1);
  });

  it("replaces the schedule when the due time moves, and cancels the old one", async () => {
    const issue = await seed();
    const { ctx, schedules } = fakeCtx();
    await rescheduleIssue(db, ctx as never, issue.id);
    // Taken and drafted: only draft_pending is left, from the draft's own clock.
    await assign(db, issue.id, "U0OWNER01");
    await createDraft(db, { issueId: issue.id, text: "Try this." });
    const moved = await rescheduleIssue(db, ctx as never, issue.id);
    expect(moved.changed).toBe(true);
    expect(moved.due?.detail).toMatch(/^draft_pending:/);
    expect(schedules.calls.map((c) => [c.op, c.id])).toEqual([
      ["create", "sched-1"],
      ["create", "sched-2"],
      ["cancel", "sched-1"],
    ]);
    expect(schedules.pending().map((c) => c.id)).toEqual(["sched-2"]);
  });

  it("cancels and clears the schedule when the issue closes", async () => {
    const issue = await seed();
    const { ctx, schedules } = fakeCtx();
    await rescheduleIssue(db, ctx as never, issue.id);
    await setStatus(db, issue.id, "closed");
    const out = await rescheduleIssue(db, ctx as never, issue.id);
    expect(out).toMatchObject({ tickId: null, at: null, changed: true });
    expect(schedules.pending()).toEqual([]);
    expect(await getIssue(db, issue.id)).toMatchObject({
      nextTickId: null,
      nextTickAt: null,
    });
  });

  it("sets an overdue ticket a short lead ahead, and after a tick an hour ahead", async () => {
    const issue = await seed(30);
    const { ctx } = fakeCtx();
    const before = await dbNow();
    const soon = await rescheduleIssue(db, ctx as never, issue.id);
    expect(soon.at!.getTime()).toBeGreaterThanOrEqual(before + MIN_LEAD_MS);
    expect(soon.at!.getTime()).toBeLessThan(before + MIN_LEAD_MS + 5_000);
    const stuck = await rescheduleIssue(db, ctx as never, issue.id, {
      tick: true,
    });
    expect(stuck.at!.getTime()).toBeGreaterThanOrEqual(
      before + STUCK_RETRY_MINUTES * 60_000,
    );
  });

  it("after a tick, a round due seconds from now keeps the short lead, not the stuck retry", async () => {
    // The issue opened 4 min 50 s ago: no_owner and no_draft come due in 10 s.
    const issue = await seed();
    await db.query(
      "update issues set created_at = now() - interval '290 seconds' where id = $1",
      [issue.id],
    );
    const { ctx } = fakeCtx();
    const before = await dbNow();
    const out = await rescheduleIssue(db, ctx as never, issue.id, {
      tick: true,
    });
    expect(out.at!.getTime()).toBeLessThan(before + MIN_LEAD_MS + 5_000);
  });

  it("sets nothing while the controller is paused, and clears what was set", async () => {
    const issue = await seed();
    const { ctx, schedules } = fakeCtx();
    await rescheduleIssue(db, ctx as never, issue.id);
    await setConfig(db, "controller.paused", true, "test");
    const out = await rescheduleIssue(db, ctx as never, issue.id);
    expect(out).toMatchObject({ tickId: null, paused: true });
    expect(schedules.pending()).toEqual([]);
  });

  it("an On Hold ticket waits for its Linear check, 1 h after it went On Hold", async () => {
    const issue = await seed();
    await assign(db, issue.id, "U0OWNER01");
    await createDraft(db, { issueId: issue.id, text: "Escalating." });
    await updateIssue(db, issue.id, {
      linearIssueId: "uuid-SAP-1",
      linearIdentifier: "SAP-1",
    });
    const held = await setStatus(db, issue.id, "on_hold");
    const due = await nextDue(db, held);
    expect(due).toMatchObject({ reason: "linear_check", detail: "SAP-1" });
    expect(due!.dueAt.getTime()).toBe(held.onHoldAt!.getTime() + 60 * 60_000);
  });

  it("a stale card is due now, so its redraw is retried", async () => {
    const issue = await seed();
    await assign(db, issue.id, "U0OWNER01");
    await createDraft(db, { issueId: issue.id, text: "Here." });
    await db.query("update issues set card_dirty = true where id = $1", [
      issue.id,
    ]);
    expect(await nextDue(db, await getIssue(db, issue.id))).toMatchObject({
      reason: "card_redraw",
    });
  });

  it("reads timing settings fresh, so a Console edit reaches a warm worker's Db", async () => {
    const issue = await seed();
    await setConfig(db, "sla", EXAMPLE_SLA, "test");
    await setConfig(db, "controller.paused", false, "test");
    // Warm this Db's config cache, as an earlier step in the same worker would.
    expect(await getConfigOr(db, "sla", null)).not.toBeNull();
    expect(await getConfigOr(db, "controller.paused", null)).toBe(false);
    // The Console writes from another process, straight to the rows: SLA removed ("Use nudge
    // minutes") and the controller switched off.
    await db.query("delete from config where key = 'sla'");
    await db.query(
      "update config set value = 'true'::jsonb where key = 'controller.paused'",
    );
    expect(await issueSla(db, await getIssue(db, issue.id))).toBeNull();
    // Back on the desk's 5 minutes, not the example SLA's 480 business minutes.
    expect((await nextDue(db, await getIssue(db, issue.id)))!.dueAt).toEqual(
      new Date(issue.createdAt.getTime() + 5 * 60_000),
    );
    const { ctx } = fakeCtx();
    expect(await rescheduleIssue(db, ctx as never, issue.id)).toMatchObject({
      paused: true,
      tickId: null,
    });
  });

  it("does nothing for an issue that does not exist", async () => {
    const { ctx, schedules } = fakeCtx();
    const out = await rescheduleIssue(
      db,
      ctx as never,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(out).toMatchObject({ tickId: null, changed: false });
    expect(schedules.calls).toEqual([]);
  });

  it("a failed create throws and leaves the stored schedule as it was", async () => {
    const issue = await seed();
    const { ctx } = fakeCtx();
    (ctx.sapiom as unknown as Record<string, unknown>).schedules = {
      create: async () => {
        throw new Error("gateway down");
      },
      cancel: async () => ({}),
    };
    await expect(rescheduleIssue(db, ctx as never, issue.id)).rejects.toThrow(
      "gateway down",
    );
    expect((await getIssue(db, issue.id)).nextTickId).toBeNull();
  });

  it("a failed cancel is logged, not thrown", async () => {
    const issue = await seed();
    const { ctx, logs } = fakeCtx();
    await rescheduleIssue(db, ctx as never, issue.id);
    (
      ctx.sapiom as unknown as { schedules: { cancel: () => Promise<never> } }
    ).schedules.cancel = async () => {
      throw new Error("already fired");
    };
    await setStatus(db, issue.id, "closed");
    await rescheduleIssue(db, ctx as never, issue.id);
    expect(logs.some((l) => l.level === "warn")).toBe(true);
  });
});

describe("rescheduleOpen", () => {
  beforeEach(async () => {
    db = await localFleetDb();
  });

  it("arms every open ticket and clears a closed one that still has a schedule", async () => {
    const a = await seed();
    const b = await seed();
    const c = await seed();
    const { ctx, schedules } = fakeCtx();
    await rescheduleIssue(db, ctx as never, c.id);
    await setStatus(db, c.id, "closed");
    const out = await rescheduleOpen(db, ctx as never);
    expect(out).toEqual({ armed: 2, cleared: 1, failed: [] });
    expect(
      schedules
        .pending()
        .map((s) => (s.input as { issueId: string }).issueId)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });
});
