import { beforeEach, describe, expect, it } from "vitest";

import { leastLoaded, membersFor, autoAssign } from "./assign";
import { setConfig } from "./config";
import { localFleetDb, type Db } from "./db";
import { accountByChannel, assign, getIssue, openIssue } from "./issues";

describe("leastLoaded / membersFor", () => {
  const a = { slackId: "UA" };
  const b = { slackId: "UB", desks: ["support"] };
  const c = { slackId: "UC", desks: ["billing"] };
  it("picks the fewest open issues, ties to the first listed", () => {
    expect(leastLoaded([a, b], new Map([["UA", 2]]))).toBe(b);
    expect(leastLoaded([a, b], new Map())).toBe(a);
    expect(leastLoaded([], new Map())).toBeNull();
  });
  it("keeps members with no desks and those listing the desk", () => {
    expect(membersFor([a, b, c], "support")).toEqual([a, b]);
  });
});

describe("autoAssign", () => {
  let db: Db;
  let n = 0;
  beforeEach(async () => {
    db = await localFleetDb();
  });
  async function open() {
    const account = (await accountByChannel(db, "C0CUSTOMER1"))!;
    return openIssue(db, {
      accountId: account.id,
      source: "slack",
      category: "question",
      priority: "normal",
      title: `t${++n}`,
      customer: { channel: "C0CUSTOMER1", ts: `179000000${n}.000100` },
    });
  }

  it("does nothing while assign.auto is off", async () => {
    await setConfig(db, "team.members", [{ slackId: "UA" }], "t");
    const issue = await open();
    expect(await autoAssign(db, issue.id)).toBeNull();
  });

  it("prefers the channel's owner, then the least-loaded member, and never replaces an owner", async () => {
    await setConfig(db, "assign.auto", true, "t");
    await setConfig(
      db,
      "team.members",
      [{ slackId: "UA" }, { slackId: "UB" }],
      "t",
    );
    const busy = await open();
    await assign(db, busy.id, "UA");
    const next = await open();
    expect(await autoAssign(db, next.id)).toBe("UB");
    expect((await getIssue(db, next.id)).ownerSlackId).toBe("UB");
    expect(await autoAssign(db, next.id)).toBeNull();

    await setConfig(
      db,
      "channels.customer",
      [
        {
          channelId: "C0CUSTOMER1",
          accountName: "Acme",
          ownerSlackId: "UOWNER",
        },
      ],
      "t",
    );
    const owned = await open();
    expect(await autoAssign(db, owned.id)).toBe("UOWNER");
  });
});
