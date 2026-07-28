import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import type { Sapiom } from "@sapiom/tools";

/** The web-search response shape, derived from the capability client. */
type WebSearchResponse = Awaited<ReturnType<Sapiom["search"]["webSearch"]>>;

/**
 * Web Research Digest — search the web for a topic and return a concise, sourced
 * digest.
 *
 * A legible "it did a thing" flagship: one metered capability (`web.search`) via
 * `ctx.sapiom.search.webSearch`, then an in-process `summarize` step that formats
 * the synthesized answer and its sources into a markdown digest — no LLM call.
 */
interface Shared extends Record<string, unknown> {
  topic: string;
  /** Set when the run researched the default topic rather than the caller's. */
  note?: string;
}

/**
 * The topic a zero-input run researches. `web.search` needs no credential, so a
 * real search is strictly better than forwarding an empty response and calling
 * the resulting empty digest a successful run.
 */
const DEFAULT_TOPIC = "what is an LLM agent?";

const search = defineStep({
  name: "search",
  next: ["summarize"],
  async run(
    input: { topic: string },
    ctx: AgentExecutionContext<Shared>,
  ) {
    const topic = input.topic?.trim() || DEFAULT_TOPIC;
    if (topic === DEFAULT_TOPIC && input.topic?.trim() !== DEFAULT_TOPIC) {
      ctx.shared.set(
        "note",
        `Researched the default topic ("${DEFAULT_TOPIC}"). Pass a \`topic\` to research yours.`,
      );
    }
    ctx.shared.set("topic", topic);
    ctx.logger.info("searching the web", { topic });
    // Metered + traced; the Sapiom search capability is pre-auth'd on ctx.sapiom.
    const response = await ctx.sapiom.search.webSearch({
      query: topic,
      intent: "answer",
    });
    ctx.logger.info("search returned", { results: response.results.length });
    return goto("summarize", response);
  },
});

const summarize = defineStep({
  name: "summarize",
  next: [],
  terminal: true,
  async run(
    response: WebSearchResponse,
    ctx: AgentExecutionContext<Shared>,
  ) {
    const topic = ctx.shared.get("topic") ?? response.query;
    const sources = response.results.map((r) => ({
      title: r.title,
      url: r.url,
    }));
    const answer = response.answer ?? "No synthesized answer was returned.";
    const digest = [
      `# Research digest: ${topic}`,
      "",
      answer,
      "",
      "## Sources",
      ...(sources.length > 0
        ? sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
        : ["_No sources found._"]),
    ].join("\n");
    ctx.logger.info("digest ready", { topic, sourceCount: sources.length });
    const note = ctx.shared.get("note");
    return terminate({ topic, digest, sources, ...(note ? { note } : {}) });
  },
});

export const agent = defineAgent<{ topic: string }, Shared>({
  name: "web-research-digest",
  entry: "search",
  steps: { search, summarize },
});
