import { describe, expect, it } from "vitest";

import type { DocEntry } from "../../_shared/docs";
import type { KbArticle } from "../../_shared/kb";
import { fakeCtx } from "../../_shared/test-ctx";
import { localFleetDb } from "../../_shared/db";
import { createArticle } from "../../_shared/kb";
import { gatherKnowledge } from "./gather";
import {
  ANSWERS_INLINE_CHARS,
  MAX_DOC_PAGES,
  answersFitInline,
  buildSelectionPrompt,
  citable,
  renderKnowledge,
  validateSelection,
} from "./knowledge";

const entry = (n: number): DocEntry => ({
  title: `Page ${n}`,
  url: `https://docs.sapiom.ai/p${n}`,
  description: `about ${n}`,
});
const INDEX = [1, 2, 3, 4, 5].map(entry);
const answer = (id: string, body = "b"): KbArticle => ({
  id,
  kind: "answer",
  title: `T ${id}`,
  body,
  enabled: true,
  deskId: null,
  updatedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("validateSelection", () => {
  it("drops urls not in the index, duplicates and extras past the cap", () => {
    const out = validateSelection(
      {
        docs: [
          INDEX[0].url,
          INDEX[0].url,
          "https://evil.example/p1",
          INDEX[1].url,
          INDEX[2].url,
          INDEX[3].url,
        ],
      },
      INDEX,
      [],
    );
    expect(out.docUrls).toEqual([INDEX[0].url, INDEX[1].url, INDEX[2].url]);
    expect(out.docUrls).toHaveLength(MAX_DOC_PAGES);
  });

  it("keeps only offered answer ids", () => {
    expect(
      validateSelection({ docs: [], answers: ["a1", "zzz"] }, INDEX, [
        answer("a1"),
      ]).answerIds,
    ).toEqual(["a1"]);
  });
});

describe("answersFitInline", () => {
  it("is true under the limit and false over it", () => {
    expect(answersFitInline([answer("a", "x".repeat(100))])).toBe(true);
    expect(
      answersFitInline([answer("a", "x".repeat(ANSWERS_INLINE_CHARS))]),
    ).toBe(false);
  });
});

describe("buildSelectionPrompt", () => {
  const issue = { title: "Deploy fails" } as never;
  const customer = (text: string) => ({ direction: "customer", text }) as never;

  it("carries the title, the latest customer messages and the index, not internal notes", () => {
    const prompt = buildSelectionPrompt({
      issue,
      messages: [
        customer("first"),
        { direction: "internal", text: "SECRETNOTE" } as never,
        customer("second"),
        customer("third"),
        customer("fourth"),
      ],
      index: INDEX,
      answers: [],
    });
    expect(prompt).toContain("Deploy fails");
    expect(prompt).not.toContain("first");
    expect(prompt).toContain("fourth");
    expect(prompt).not.toContain("SECRETNOTE");
    expect(prompt).toContain("https://docs.sapiom.ai/p5 | Page 5: about 5");
    expect(prompt).not.toContain("<team_answers>");
  });

  it("lists answer ids and titles when answers are offered", () => {
    const prompt = buildSelectionPrompt({
      issue,
      messages: [],
      index: INDEX,
      answers: [answer("a1")],
    });
    expect(prompt).toContain("a1 | T a1");
  });
});

describe("gatherKnowledge", () => {
  const llms = INDEX.map(
    (e) => `- [${e.title}](${e.url}): ${e.description}`,
  ).join("\n");
  const baseCtx = (picked: unknown, fail = false) => {
    const fake = fakeCtx({ isLocalTrace: true });
    const calls: Record<string, unknown>[] = [];
    (fake.ctx.sapiom as Record<string, unknown>).llm = {
      async run(spec: Record<string, unknown>) {
        calls.push(spec);
        if (fail) throw new Error("llm down");
        return { picked };
      },
      structuredOf: (r: { picked: unknown }) => r.picked,
    };
    return { ...fake, calls };
  };
  const input = { issue: { title: "t" } as never, messages: [] };
  const deps = (fetcher: (u: string) => Promise<string>) => ({ fetcher });

  it("includes all answers without a selection of them when they are few", async () => {
    const db = await localFleetDb();
    await createArticle(db, { kind: "answer", title: "A", body: "b" }, "t");
    const t = baseCtx({ docs: [INDEX[0].url] });
    const k = await gatherKnowledge(
      t.ctx as never,
      db,
      input,
      deps(async (u) => (u.endsWith("llms.txt") ? llms : "PAGEBODY")),
    );
    expect(k.answers).toHaveLength(1);
    expect(k.docs).toEqual([
      { url: INDEX[0].url, title: "Page 1", body: "PAGEBODY" },
    ]);
    expect(k.docsUnavailable).toBe(false);
    expect(citable(k)).toContain(INDEX[0].url);
    const schema = (t.calls[0].output as { schema: { properties: object } })
      .schema;
    expect(schema.properties).not.toHaveProperty("answers");
  });

  it("selects among answers when they are too many to include whole", async () => {
    const db = await localFleetDb();
    const big = "x".repeat(ANSWERS_INLINE_CHARS);
    const a = await createArticle(
      db,
      { kind: "answer", title: "A", body: big },
      "t",
    );
    await createArticle(db, { kind: "answer", title: "B", body: "small" }, "t");
    const t = baseCtx({ docs: [], answers: [a.id, "not-an-id"] });
    const k = await gatherKnowledge(
      t.ctx as never,
      db,
      input,
      deps(async () => llms),
    );
    expect(k.answers.map((x) => x.id)).toEqual([a.id]);
  });

  it("a failed page read keeps the draft going; all failing flags docs unavailable", async () => {
    const db = await localFleetDb();
    const t = baseCtx({ docs: [INDEX[0].url] });
    const k = await gatherKnowledge(
      t.ctx as never,
      db,
      input,
      deps(async (u) => {
        if (u.endsWith("llms.txt")) return llms;
        throw new Error("page down");
      }),
    );
    expect(k.docs).toEqual([]);
    expect(k.docsUnavailable).toBe(true);
    expect(t.logs.some((l) => l.msg === "docs page unavailable")).toBe(true);
  });

  it("a failed selection call degrades instead of throwing", async () => {
    const db = await localFleetDb();
    const t = baseCtx(undefined, true);
    const k = await gatherKnowledge(
      t.ctx as never,
      db,
      input,
      deps(async () => llms),
    );
    expect(k).toMatchObject({ docs: [], docsUnavailable: true });
  });

  it("a malformed selection response degrades", async () => {
    const db = await localFleetDb();
    const t = baseCtx({ nope: 1 });
    const k = await gatherKnowledge(
      t.ctx as never,
      db,
      input,
      deps(async () => llms),
    );
    expect(k.docsUnavailable).toBe(true);
  });

  it("a failed selection falls back to the most recent answers within the inline budget", async () => {
    const db = await localFleetDb();
    const half = "x".repeat(Math.floor(ANSWERS_INLINE_CHARS * 0.6));
    const older = await createArticle(
      db,
      { kind: "answer", title: "Older", body: half },
      "t",
    );
    const newer = await createArticle(
      db,
      { kind: "answer", title: "Newer", body: half },
      "t",
    );
    await db.query(
      "update kb_articles set updated_at = now() - interval '1 day' where id = $1",
      [older.id],
    );
    const t = baseCtx(undefined, true);
    const k = await gatherKnowledge(
      t.ctx as never,
      db,
      input,
      deps(async () => llms),
    );
    expect(k.answers.map((x) => x.id)).toEqual([newer.id]);
  });

  it("names the pages that failed when only some selected pages load", async () => {
    const db = await localFleetDb();
    const t = baseCtx({ docs: [INDEX[0].url, INDEX[1].url] });
    const k = await gatherKnowledge(
      t.ctx as never,
      db,
      input,
      deps(async (u) => {
        if (u.endsWith("llms.txt")) return llms;
        if (u.includes("/p2")) throw new Error("page down");
        return "PAGEBODY";
      }),
    );
    expect(k.docs.map((d) => d.url)).toEqual([INDEX[0].url]);
    expect(k.docsUnavailable).toBe(true);
    expect(k.failedDocs).toEqual([INDEX[1].url]);
    expect(renderKnowledge(k)).toContain(INDEX[1].url);
    expect(renderKnowledge(k)).toContain("could not be read");
  });
});
