import { z } from "zod/v4";
import type { RawArticle, SelectedArticle } from "./types.js";

const selectionSchema = z
  .array(
    z.object({
      title: z.string().min(1),
      url: z.string().min(1),
      summary: z.string().min(1),
      imagePrompt: z.string().min(1),
    }),
  )
  .min(1)
  .max(5);

export function buildSelectionPrompt(
  companyName: string,
  runDate: string,
  articles: RawArticle[],
): string {
  const list = articles
    .map((a, i) => `${i + 1}. ${a.title}\n   URL: ${a.url}\n   Excerpt: ${a.snippet}`)
    .join("\n");
  return `Today is ${runDate}. Below are web search results for news about the company "${companyName}".

Select the 3 to 5 results that are genuinely recent news (roughly the last 7 days) about this specific company. Drop results about unrelated companies or people with similar names, duplicates, and pages that are not news articles. If fewer than 3 qualify, select only those that do (minimum 1).

For each selected article provide:
- "title": the article title
- "url": the article URL, copied exactly as given
- "summary": 2-3 plain-language sentences a non-expert understands (no jargon)
- "imagePrompt": one sentence describing a simple, friendly illustration of the story (no text or logos in the image)

Respond with ONLY a JSON array of objects with keys "title", "url", "summary", "imagePrompt".

Search results:
${list}`;
}

export function parseSelection(output: string): SelectedArticle[] {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("no JSON array found in model output");
  return selectionSchema.parse(JSON.parse(output.slice(start, end + 1)));
}
