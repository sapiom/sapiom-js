import { describe, expect, it } from "vitest";

import { localFleetDb } from "./db";
import {
  accountByChannel,
  getIssue,
  openIssue,
  setStatus,
  setTriageRoot,
} from "./issues";
import { resetBoard } from "./reset";
import { fakeCtx } from "./test-ctx";

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
  await setTriageRoot(db, carded.id, "1790000002.000100");
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

  it("writes nothing on a dry run", async () => {
    const { db, carded } = await seeded();
    const out = await resetBoard(db, fakeCtx({ isLocalTrace: true }).ctx, {
      dryRun: true,
    });
    expect(out.map((o) => o.card)).toEqual(["dry run", "dry run"]);
    expect((await getIssue(db, carded.id)).status).toBe("new");
  });
});
