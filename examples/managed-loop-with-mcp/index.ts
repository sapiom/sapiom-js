import {
  defineAgent,
  defineStep,
  fail,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import {
  MODEL_RUN_RESULT_SIGNAL,
  type ModelMcp,
  type ModelRunResultPayload,
} from "@sapiom/tools";
import { z } from "zod/v4";

/**
 * Managed Loop with MCP — answer a question with the managed loop, using a
 * remote MCP server as the model's tools.
 *
 *   prepare ─┬─▶ ask ──(pause: models.run.result)──▶ report
 *            └─▶ rejected
 *
 * `ask` calls `ctx.sapiom.models.launch` with a prompt, a system prompt and one
 * MCP server in `mcps`. The managed loop runs in Sapiom's server: it calls the
 * model, calls the MCP server's tools when the model asks for them, and repeats
 * until the model answers. `ask` pauses on the launch handle; the platform fires
 * `models.run.result` when the run finishes and `report` receives the result.
 *
 * `model` is omitted on purpose: the platform routes the run. Pass a model label
 * (`"small"`, `"medium"`, `"large"`) only to pick a billing class; a raw
 * provider model id is never honored.
 *
 * Runs with nothing: the default MCP server is DeepWiki's public server
 * (https://mcp.deepwiki.com/mcp, no auth), which answers questions about public
 * GitHub repositories. Point `mcpUrl` at another public Streamable HTTP MCP
 * server to use its tools instead.
 *
 * The server gets no credentials. To call a server that needs auth, fix its URL
 * in code and add the header in `mcpFor`; never attach a credential to a URL
 * taken from run input, or whoever starts a run can send it anywhere.
 */

const DEFAULT_MCP_URL = "https://mcp.deepwiki.com/mcp";
const DEFAULT_QUESTION =
  "In the modelcontextprotocol/typescript-sdk repository, how does the Streamable HTTP server transport handle a request? Answer in at most five bullets.";

const SYSTEM_PROMPT = [
  "You answer questions using the tools you have been given.",
  "Call a tool before answering whenever the question is about something the tools can look up.",
  "Answer in plain text. If the tools return nothing useful, say so instead of guessing.",
].join(" ");

/**
 * The entry contract. Both fields default, so `{}` in produces a real run. A
 * value the schema accepts but the run cannot use (a non-https URL) reaches
 * `prepare`, which turns it into a readable rejection.
 */
const entryInput = z.object({
  question: z
    .string()
    .default(DEFAULT_QUESTION)
    .describe(
      "What to ask. The model may call the MCP server's tools to answer it.",
    ),
  mcpUrl: z
    .string()
    .default(DEFAULT_MCP_URL)
    .describe("The Streamable HTTP MCP server whose tools the model can call."),
});

interface Shared extends Record<string, unknown> {
  question: string;
  mcpUrl: string;
}

type Ctx = AgentExecutionContext<Shared>;

/** Accept only an absolute https URL; anything else is a readable rejection. */
export function parseMcpUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export type ReadInput =
  | { ok: true; question: string; mcpUrl: string }
  | { ok: false; reason: string; mcpUrl: string | null };

/** Resolve the entry input; an unusable server URL is a rejection. */
export function readInput(input: {
  question?: string;
  mcpUrl?: string;
}): ReadInput {
  const question = (input.question ?? "").trim() || DEFAULT_QUESTION;
  const mcpUrl = parseMcpUrl(input.mcpUrl ?? DEFAULT_MCP_URL);
  if (!mcpUrl) {
    return {
      ok: false,
      reason: "`mcpUrl` must be an absolute https URL.",
      mcpUrl: input.mcpUrl ?? null,
    };
  }
  return { ok: true, question, mcpUrl };
}

/**
 * The MCP server entry for `models.launch`. It carries no credentials: the URL
 * comes from run input, so a header here would go wherever the caller points it.
 */
export function mcpFor(mcpUrl: string): ModelMcp {
  return { url: mcpUrl };
}

export type ReadRun =
  | { ok: true; answer: string }
  | { ok: false; reason: string };

/** A failed or empty run is a failure with a reason; nothing is made up. */
export function readRun(run: ModelRunResultPayload): ReadRun {
  if (run.status !== "completed") {
    return {
      ok: false,
      reason: run.error?.message ?? `the run ended with status ${run.status}`,
    };
  }
  const answer = (run.output ?? "").trim();
  return answer
    ? { ok: true, answer }
    : { ok: false, reason: "the run completed without an answer" };
}

const prepare = defineStep({
  name: "prepare",
  inputSchema: entryInput,
  next: ["ask", "rejected"],
  async run(input: { question?: string; mcpUrl?: string }, ctx: Ctx) {
    const read = readInput(input);
    if (!read.ok) {
      return goto("rejected", { reason: read.reason, mcpUrl: read.mcpUrl });
    }
    ctx.shared.set("question", read.question);
    ctx.shared.set("mcpUrl", read.mcpUrl);
    return goto("ask", {});
  },
});

/** Launch the managed loop with the MCP server as its tools, then pause. */
const ask = defineStep({
  name: "ask",
  next: [],
  pause: { signal: MODEL_RUN_RESULT_SIGNAL, resumeStep: "report" },
  async run(_input: unknown, ctx: Ctx) {
    const question = ctx.shared.get("question") ?? DEFAULT_QUESTION;
    const mcpUrl = ctx.shared.get("mcpUrl") ?? DEFAULT_MCP_URL;

    ctx.logger.info("launching the managed loop", { mcpUrl });
    const handle = await ctx.sapiom.models.launch({
      prompt: question,
      system: SYSTEM_PROMPT,
      mcps: [mcpFor(mcpUrl)],
    });
    return await pauseUntilSignal(handle, { resumeStep: "report" });
  },
});

/** Read the run result. A failed or empty run fails the step; nothing is made up. */
const report = defineStep({
  name: "report",
  next: [],
  terminal: true,
  canFail: true,
  async run(run: ModelRunResultPayload, ctx: Ctx) {
    const read = readRun(run);
    if (!read.ok) return fail(read.reason);

    return terminate({
      question: ctx.shared.get("question") ?? DEFAULT_QUESTION,
      mcpUrl: ctx.shared.get("mcpUrl") ?? DEFAULT_MCP_URL,
      answer: read.answer,
      runId: run.runId,
      turns: run.result?.turns ?? null,
      servedClass: run.result?.servedClass ?? null,
      warnings: run.result?.warnings ?? [],
    });
  },
});

/** Terminal off-ramp for an unusable `mcpUrl`. */
const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(input: { reason: string; mcpUrl: string | null }) {
    return terminate({ rejected: true, ...input });
  },
});

export const agent = defineAgent({
  name: "managed-loop-with-mcp",
  entry: "prepare",
  steps: { prepare, ask, report, rejected },
});
