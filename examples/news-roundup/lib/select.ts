import { z } from "zod/v4";
import type { RawArticle, SelectedArticle } from "./types.js";

const selectionSchema = z.object({
  articles: z
    .array(
      z.object({
        title: z.string().min(1),
        url: z.string().min(1),
        summary: z.string().min(1),
        imagePrompt: z.string().min(1),
      }),
    )
    .max(5),
});

/**
 * The forced tool call the `select` step reads its selection out of. `llm.run`'s
 * `output` appends this tool to the request and pins `tool_choice` to it, so the
 * selection arrives as a typed `tool_use` block — nothing to slice out of prose,
 * no code fences to strip.
 */
export const SELECTION_TOOL = "emit_selection";

export const SELECTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "The article title." },
          url: {
            type: "string",
            description: "The article URL, copied exactly as given.",
          },
          summary: {
            type: "string",
            description:
              "2-3 plain-language sentences a non-expert understands. No jargon.",
          },
          imagePrompt: {
            type: "string",
            description:
              "One sentence describing a simple, friendly illustration of the story. No text or logos in the image.",
          },
        },
        required: ["title", "url", "summary", "imagePrompt"],
        additionalProperties: false,
      },
      description:
        "The 3 to 5 results that are genuinely recent news about this company. Fewer if fewer qualify; empty if none do.",
    },
  },
  required: ["articles"],
  additionalProperties: false,
};

export function buildSelectionPrompt(
  companyName: string,
  runDate: string,
  articles: RawArticle[],
): string {
  const list = articles
    .map((a, i) => `${i + 1}. ${a.title}\n   URL: ${a.url}\n   Excerpt: ${a.snippet}`)
    .join("\n");
  return `Today is ${runDate}. Below are web search results for news about the company "${companyName}".

Select the 3 to 5 results that are genuinely recent news (roughly the last 7 days) about this specific company. Drop results about unrelated companies or people with similar names, duplicates, and pages that are not news articles. If fewer than 3 qualify, select only those that do. If none qualify, respond with an empty array [].

For each selected article provide:
- "title": the article title
- "url": the article URL, copied exactly as given
- "summary": 2-3 plain-language sentences a non-expert understands (no jargon)
- "imagePrompt": one sentence describing a simple, friendly illustration of the story (no text or logos in the image)

Search results:
${list}`;
}

/**
 * Read the forced tool call back into the selection.
 *
 * Throws when the model returned no such block, or one that does not satisfy
 * `selectionSchema` — an unusable reply must not become an empty selection,
 * because an empty selection is a real answer here ("nothing qualified") that
 * routes the run to the `noNews` terminal.
 */
export function readSelection(structured: unknown): SelectedArticle[] {
  if (structured === null || typeof structured !== "object") {
    throw new Error("select: the model returned no structured selection");
  }
  return selectionSchema.parse(structured).articles;
}
