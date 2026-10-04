import { describe, expect, it } from "vitest";

import { localFleetDb, memoryDb, type Db } from "./db";
import { defaultDesk, upsertDesk } from "./desks";
import {
  accountByChannel,
  ensureAccount,
  getIssue,
  openIssue,
  setStatus,
  setTriageRoot,
} from "./issues";
import { resetBoard } from "./reset";
import { fakeCtx } from "./test-ctx";
import { rescheduleIssue } from "./timers";

async function seeded() {
  const db = await localFleetDb();
  const account = (await accountByChannel(db, "C0CUSTOMER1"))!;
  const open = (title: string, ts: string) =>
    openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "normal",
      title,
      customer: { channel: "C0CUSTOMER1", ts },
    });
  const carded = await open("has a card", "1790000001.000100");
  await setTriageRoot(db, carded.id, "C0TRIAGE001", "1790000002.000100");
  const bare = await open("no card", "1790000003.000100");
  await setStatus(db, bare.id, "on_customer");
  const closed = await open("already closed", "1790000004.000100");
  await setStatus(db, closed.id, "closed");
  return { db, carded, bare, closed };
}

describe("resetBoard", () => {
  it("closes every open issue and redraws the cards it has", async () => {
    const { db, carded, bare, closed } = await seeded();
    const { ctx } = fakeCtx({ isLocalTrace: true });
    const out = await resetBoard(db, ctx);
    expect(out.map((o) => [o.issueId, o.was, o.card])).toEqual([
      [carded.id, "new", "redrawn"],
      [bare.id, "on_customer", "no card"],
    ]);
    for (const id of [carded.id, bare.id, closed.id])
      expect((await getIssue(db, id)).status).toBe("closed");
    expect(await resetBoard(db, ctx)).toEqual([]);
  });

  it("cancels each closed issue's controller timer", async () => {
    const { db, carded } = await seeded();
    const { ctx, schedules } = fakeCtx();
    await rescheduleIssue(db, ctx as never, carded.id);
    expect(schedules.pending()).toHaveLength(1);
    await resetBoard(db, ctx as never);
    expect(schedules.pending()).toEqual([]);
    expect((await getIssue(db, carded.id)).nextTickId).toBeNull();
  });

  it("redraws cards through the client in ctx.sapiom, not the ambient connector", async () => {
    const { db, carded } = await seeded();
    const updates: Record<string, unknown>[] = [];
    const { ctx } = fakeCtx();
    (ctx as { sapiom: unknown }).sapiom = {
      connectors: {
        slack: {
          update: async (args: Record<string, unknown>) => {
            updates.push(args);
            return { ok: true };
          },
        },
      },
    };
    const out = await resetBoard(db, ctx);
    expect(out.find((o) => o.issueId === carded.id)?.card).toBe("redrawn");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ ts: "1790000002.000100" });
  });

  it("writes nothing on a dry run", async () => {
    const { db, carded } = await seeded();
    const out = await resetBoard(db, fakeCtx({ isLocalTrace: true }).ctx, {
      dryRun: true,
    });
    expect(out.map((o) => o.card)).toEqual(["dry run", "dry run"]);
    expect((await getIssue(db, carded.id)).status).toBe("new");
  });

  it("resets only the given desk, redrawing in that desk's triage channel", async () => {
    const { db, carded, bare } = await seeded();
    const other = (
      await upsertDesk(db, {
        slug: "other",
        name: "Other",
        triageChannel: "C0OTHER",
      })
    ).desk;
    const account = await ensureAccount(db, {
      name: "Other co",
      slackChannelId: "C0OTHERCUST",
      deskId: other.id,
    });
    const theirs = await openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "bug",
      priority: "normal",
      title: "other desk",
      customer: { channel: "C0OTHERCUST", ts: "1790000005.000100" },
    });
    await setTriageRoot(db, theirs.id, "C0OTHER", "1790000006.000100");

    const updates: Record<string, unknown>[] = [];
    const { ctx } = fakeCtx();
    (ctx as { sapiom: unknown }).sapiom = {
      connectors: {
        slack: {
          update: async (args: Record<string, unknown>) => {
            updates.push(args);
            return { ok: true };
          },
        },
      },
    };
    const out = await resetBoard(db, ctx, { deskId: other.id });
    expect(out.map((o) => o.issueId)).toEqual([theirs.id]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      channel: "C0OTHER",
      ts: "1790000006.000100",
    });
    expect((await getIssue(db, theirs.id)).status).toBe("closed");
    expect((await getIssue(db, carded.id)).status).toBe("new");
    expect((await getIssue(db, bare.id)).status).toBe("on_customer");
  });

  const recordingCtx = () => {
    const updates: Record<string, unknown>[] = [];
    const { ctx } = fakeCtx();
    (ctx as { sapiom: unknown }).sapiom = {
      connectors: {
        slack: {
          update: async (args: Record<string, unknown>) => {
            updates.push(args);
            return { ok: true };
          },
        },
      },
    };
    return { ctx, updates };
  };

  it("redraws a card in the channel it was posted in after its desk's channel moves", async () => {
    const { db } = await seeded();
    const support = (await defaultDesk(db))!;
    await upsertDesk(
      db,
      { ...support, triageChannel: "C0NEW" },
      { overwrite: true },
    );
    const { ctx, updates } = recordingCtx();
    await resetBoard(db, ctx);
    expect(updates).toEqual([
      expect.objectContaining({
        channel: "C0TRIAGE001",
        ts: "1790000002.000100",
      }),
    ]);
  });

  it("runs on a database not yet migrated to 082, redrawing in the desk's channel", async () => {
    const db: Db = await memoryDb({ through: "081_desk_triage_unique" });
    const [desk] = await db.query<{ id: string }>(
      "insert into desks (slug, name, triage_channel, is_default) values ('support', 'Support', 'C0DESK', true) returning id",
    );
    const [account] = await db.query<{ id: string }>(
      "insert into accounts (name, slack_channel_id, desk_id) values ('Acme', 'C0ACME', $1) returning id",
      [desk.id],
    );
    await db.query(
      "insert into issues (account_id, desk_id, source, title, triage_root_ts) values ($1, $2, 'slack', 'old card', '1790000009.000100')",
      [account.id, desk.id],
    );
    const { ctx, updates } = recordingCtx();
    const out = await resetBoard(db, ctx);
    expect(out.map((o) => o.card)).toEqual(["redrawn"]);
    expect(updates).toEqual([
      expect.objectContaining({ channel: "C0DESK", ts: "1790000009.000100" }),
    ]);
  });
});
