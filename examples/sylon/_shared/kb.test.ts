import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "./db";
import { memoryDb } from "./db";
import {
  STARTER_POLICIES,
  articleTitles,
  countArticles,
  createArticle,
  deleteArticle,
  getArticle,
  listArticles,
  listEnabled,
  seedStarters,
  updateArticle,
} from "./kb";

let db: Db;
beforeEach(async () => {
  db = await memoryDb();
});

describe("kb articles", () => {
  it("creates, reads and lists with the editor recorded", async () => {
    const a = await createArticle(
      db,
      { kind: "answer", title: "Exports", body: "Links last 7 days." },
      "console",
    );
    expect(a).toMatchObject({
      kind: "answer",
      title: "Exports",
      enabled: true,
      updatedBy: "console",
    });
    expect(await getArticle(db, a.id)).toMatchObject({ id: a.id });
    expect(await listArticles(db)).toHaveLength(1);
  });

  it("lists policies before answers", async () => {
    await createArticle(db, { kind: "answer", title: "A", body: "b" }, "t");
    await createArticle(db, { kind: "policy", title: "Z", body: "b" }, "t");
    expect((await listArticles(db)).map((a) => a.kind)).toEqual([
      "policy",
      "answer",
    ]);
  });

  it("updates only the given fields and stamps the editor", async () => {
    const a = await createArticle(
      db,
      { kind: "answer", title: "Old", body: "body" },
      "setup",
    );
    const u = await updateArticle(db, a.id, { title: "New" }, "console");
    expect(u).toMatchObject({
      title: "New",
      body: "body",
      kind: "answer",
      updatedBy: "console",
    });
    expect(
      await updateArticle(db, "00000000-0000-4000-8000-000000000000", {}, "c"),
    ).toBeNull();
  });

  it("writes only the patched columns, so a stale copy cannot revert another edit", async () => {
    const a = await createArticle(
      db,
      { kind: "answer", title: "Old", body: "body" },
      "setup",
    );
    // Two editors patch different fields; neither has read the other's change.
    await updateArticle(db, a.id, { title: "New" }, "one");
    await updateArticle(db, a.id, { enabled: false }, "two");
    expect(await getArticle(db, a.id)).toMatchObject({
      title: "New",
      enabled: false,
      updatedBy: "two",
    });
  });

  it("disabled articles are not read by the copilot", async () => {
    const a = await createArticle(
      db,
      { kind: "policy", title: "P", body: "b" },
      "t",
    );
    await updateArticle(db, a.id, { enabled: false }, "t");
    expect(await listEnabled(db)).toHaveLength(0);
    expect(await listArticles(db)).toHaveLength(1);
  });

  it("rejects a kind the table does not allow", async () => {
    await expect(
      createArticle(db, { kind: "memo" as never, title: "t", body: "b" }, "t"),
    ).rejects.toThrow();
  });

  it("deletes and reports whether a row was removed", async () => {
    const a = await createArticle(
      db,
      { kind: "policy", title: "P", body: "b" },
      "t",
    );
    expect(await deleteArticle(db, a.id)).toBe(true);
    expect(await deleteArticle(db, a.id)).toBe(false);
    expect(await countArticles(db)).toBe(0);
  });

  it("resolves titles for known ids and skips unknown or malformed ones", async () => {
    const a = await createArticle(
      db,
      { kind: "policy", title: "P", body: "b" },
      "t",
    );
    const titles = await articleTitles(db, [
      a.id,
      "not-a-uuid",
      "https://docs.sapiom.ai/x",
    ]);
    expect([...titles]).toEqual([[a.id, "P"]]);
  });

  it("seeds starters only into an empty table", async () => {
    expect(await seedStarters(db)).toBe(STARTER_POLICIES.length);
    expect(await seedStarters(db)).toBe(0);
    expect(await countArticles(db)).toBe(STARTER_POLICIES.length);
    expect((await listArticles(db)).every((a) => a.updatedBy === "setup")).toBe(
      true,
    );
  });
});
