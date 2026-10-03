/**
 * Assemble the knowledge for one draft: the team's enabled articles from the database, then one
 * small selection call over the docs index to pick pages (and answers, when there are many).
 *
 * A docs outage never fails a run. A failed index, selection or page read is logged and the draft
 * proceeds from the team's articles alone, flagged `docsUnavailable` so its confidence is capped. A page that fails while others load is named
 * in `failedDocs`.
 */
import type { AgentExecutionContext } from "@sapiom/agent";

import type { Db } from "../../_shared/db";
import {
  docsDeps,
  getIndex,
  getPage,
  type DocEntry,
  type DocsDeps,
} from "../../_shared/docs";
import type { Issue, Message } from "../../_shared/issues";
import { listEnabled, type KbArticle } from "../../_shared/kb";
import {
  SELECT_OUTPUT_NAME,
  SELECT_SYSTEM,
  ANSWERS_INLINE_CHARS,
  SelectOutput,
  answersFitInline,
  buildSelectionPrompt,
  selectionSchema,
  validateSelection,
  type DocPage,
  type Knowledge,
  type Selection,
} from "./knowledge";

type Ctx = AgentExecutionContext<Record<string, unknown>>;

/** Covers a routed label's thinking plus the forced tool call; the answer itself is a few urls. */
const SELECT_MAX_TOKENS = 2048;

async function select(
  ctx: Ctx,
  input: Parameters<typeof buildSelectionPrompt>[0],
): Promise<Selection> {
  const response = await ctx.sapiom.llm.run({
    model: "small",
    request: {
      system: SELECT_SYSTEM,
      messages: [{ role: "user", content: buildSelectionPrompt(input) }],
      max_tokens: SELECT_MAX_TOKENS,
    },
    output: {
      name: SELECT_OUTPUT_NAME,
      schema: selectionSchema(input.answers.length > 0),
    },
  });
  const parsed = SelectOutput.safeParse(
    ctx.sapiom.llm.structuredOf(response, SELECT_OUTPUT_NAME),
  );
  if (!parsed.success)
    throw new Error("selection returned no structured output");
  return validateSelection(parsed.data, input.index, input.answers);
}

/** The most recently updated answers that fit the inline budget: the fallback when selection fails. */
function recentAnswers(answers: readonly KbArticle[]): KbArticle[] {
  const kept: KbArticle[] = [];
  let chars = 0;
  for (const a of [...answers].sort(
    (x, y) => y.updatedAt.getTime() - x.updatedAt.getTime(),
  )) {
    chars += a.title.length + a.body.length;
    if (chars > ANSWERS_INLINE_CHARS) break;
    kept.push(a);
  }
  return kept;
}

export async function gatherKnowledge(
  ctx: Ctx,
  db: Db,
  input: { issue: Issue; messages: readonly Message[] },
  deps: DocsDeps = docsDeps(ctx),
): Promise<Knowledge> {
  const enabled = await listEnabled(db);
  const policies = enabled.filter((a) => a.kind === "policy");
  const allAnswers = enabled.filter((a) => a.kind === "answer");
  const inline = answersFitInline(allAnswers);
  const offered = inline ? [] : allAnswers;

  let index: DocEntry[] = [];
  let docsUnavailable = false;
  try {
    index = await getIndex(db, deps);
    if (index.length === 0) throw new Error("llms.txt lists no pages");
  } catch (err) {
    docsUnavailable = true;
    ctx.logger.warn(
      "docs index unavailable; drafting from the team knowledge base",
      {
        err: String(err),
      },
    );
  }

  let selection: Selection = { docUrls: [], answerIds: [] };
  let selectionFailed = false;
  if (index.length > 0 || offered.length > 0) {
    try {
      selection = await select(ctx, { ...input, index, answers: offered });
    } catch (err) {
      docsUnavailable = true;
      selectionFailed = true;
      ctx.logger.warn("source selection failed; drafting without docs", {
        err: String(err),
      });
    }
  }

  const titleOf = new Map(index.map((e) => [e.url, e.title]));
  const settled = await Promise.allSettled(
    selection.docUrls.map(async (url): Promise<DocPage> => ({
      url,
      title: titleOf.get(url) ?? url,
      body: await getPage(db, url, deps),
    })),
  );
  const docs: DocPage[] = [];
  const failedDocs: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") docs.push(r.value);
    else {
      failedDocs.push(selection.docUrls[i]);
      ctx.logger.warn("docs page unavailable", {
        url: selection.docUrls[i],
        err: String(r.reason),
      });
    }
  });
  if (failedDocs.length > 0) docsUnavailable = true;

  const chosen = new Set(selection.answerIds);
  return {
    policies,
    answers: inline
      ? allAnswers
      : selectionFailed
        ? recentAnswers(allAnswers)
        : allAnswers.filter((a) => chosen.has(a.id)),
    docs,
    docsUnavailable,
    failedDocs,
  };
}
