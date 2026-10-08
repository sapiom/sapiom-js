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
 * GitHub repositories. Point `mcpUrl` at your own Streamable HTTP MCP server and
 * set `MCP_AUTH_TOKEN` when it needs a bearer token.
 */

const DEFAULT_MCP_URL = "https://mcp.deepwiki.com/mcp";
const DEFAULT_QUESTION =
  "In the modelcontextprotocol/typescript-sdk repository, how does the Streamable HTTP server transport handle a request? Answer in at most five bullets.";

const SYSTEM_PROMPT = [
  "You answer questions using the tools you have been given.",
  "Call a tool before answering whenever the question is about something the tools can look up.",
  "Answer in plain text. If the tools return nothing useful, say so instead of guessing.",
].join(" ");

/** The entry contract. Both fields default, so `{}` in produces a real run. */
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
  /** True when `MCP_AUTH_TOKEN` was sent as a bearer token. */
  authenticated: boolean;
}

type Ctx = AgentExecutionContext<Shared>;

/** Accept only an absolute https URL; anything else is a readable rejection. */
function parseMcpUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const prepare = defineStep({
  name: "prepare",
  inputSchema: entryInput,
  next: ["ask", "rejected"],
  async run(input: { question?: string; mcpUrl?: string }, ctx: Ctx) {
    const question = (input.question ?? "").trim() || DEFAULT_QUESTION;
    const mcpUrl = parseMcpUrl(input.mcpUrl ?? DEFAULT_MCP_URL);
    if (!mcpUrl) {
      return goto("rejected", {
        reason: "`mcpUrl` must be an absolute https URL.",
        mcpUrl: input.mcpUrl ?? null,
      });
    }
    ctx.shared.set("question", question);
    ctx.shared.set("mcpUrl", mcpUrl);
    ctx.shared.set("authenticated", Boolean(process.env.MCP_AUTH_TOKEN));
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
    const token = process.env.MCP_AUTH_TOKEN;
    const mcp: ModelMcp = token
      ? { url: mcpUrl, headers: { authorization: `Bearer ${token}` } }
      : { url: mcpUrl };

    ctx.logger.info("launching the managed loop", { mcpUrl });
    const handle = await ctx.sapiom.models.launch({
      prompt: question,
      system: SYSTEM_PROMPT,
      mcps: [mcp],
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
    if (run.status !== "completed") {
      return fail(
        run.error?.message ?? `the run ended with status ${run.status}`,
      );
    }
    const answer = (run.output ?? "").trim();
    if (!answer) return fail("the run completed without an answer");

    return terminate({
      question: ctx.shared.get("question") ?? DEFAULT_QUESTION,
      mcpUrl: ctx.shared.get("mcpUrl") ?? DEFAULT_MCP_URL,
      answer,
      runId: run.runId,
      turns: run.result?.turns ?? null,
      servedClass: run.result?.servedClass ?? null,
      warnings: run.result?.warnings ?? [],
      authenticated: ctx.shared.get("authenticated") === true,
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
