/**
 * draft.ts — builds the writer's prompt: the brief, the rubric (so the writer
 * aims at the same bar the judge grades against), and — on a revision attempt
 * — the previous draft plus the judge's critique.
 *
 * Mirrors `judge.ts`: this file only builds a prompt string. The model call
 * itself lives in the `draft` step in `index.ts`, via `ctx.sapiom.llm.run`.
 */

/** What the previous attempt was, and why it fell short. */
export interface RevisionContext {
  draft: string;
  critique: string;
}

/**
 * Build the draft prompt. On the first attempt this is BRIEF + RUBRIC alone.
 * On a revision it also carries the rejected draft and the judge's critique,
 * so the model addresses each point in place rather than starting over blind.
 */
export function buildDraftPrompt(args: {
  brief: string;
  rubric: string;
  revision?: RevisionContext;
}): string {
  const { brief, rubric, revision } = args;
  const parts = [
    "You are a careful writer. Write a piece that satisfies the BRIEF and clears the RUBRIC below.",
    "Reply with ONLY the piece itself — no preamble, no headers, no meta-commentary.",
    "",
    "BRIEF (what to write):",
    brief,
    "",
    "RUBRIC (what the piece will be graded against):",
    rubric,
  ];
  if (revision) {
    parts.push(
      "",
      "Your previous attempt did not clear the rubric. Revise it — address every point in the",
      "CRITIQUE precisely, keep what already worked, and do not reintroduce the same issue.",
      "",
      "PREVIOUS DRAFT:",
      revision.draft,
      "",
      "CRITIQUE (why it fell short):",
      revision.critique,
    );
  }
  return parts.join("\n");
}
