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
 * GitHub repositories. Point `mcpUrl` at another Streamable HTTP MCP server, or
 * set the `MCP_URL` secret to make your own server the default.
 *
 * `MCP_AUTH_TOKEN` is sent only to the origin of the `MCP_URL` secret. A run
 * that passes some other `mcpUrl` gets no token, so a caller cannot send your
 * token to a server of their choosing.
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
 * The entry contract. Both fields are optional and accept any value, so `{}`
 * produces a real run and a malformed value reaches `prepare`, which turns it
 * into a readable rejection instead of an entry-validation failure.
 */
const entryInput = z.object({
  question: z
    .unknown()
    .optional()
    .describe(
      "What to ask. The model may call the MCP server's tools to answer it.",
    ),
  mcpUrl: z
    .unknown()
    .optional()
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
export function parseMcpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export type ReadInput =
  | { ok: true; question: string; mcpUrl: string }
  | { ok: false; reason: string; mcpUrl: unknown };

/**
 * Resolve the entry input. An omitted field takes its default (`MCP_URL` when
 * set, else DeepWiki); a present but unusable one is a rejection.
 */
export function readInput(
  input: { question?: unknown; mcpUrl?: unknown },
  configuredUrl: string | undefined,
): ReadInput {
  if (input.question !== undefined && typeof input.question !== "string") {
    return {
      ok: false,
      reason: "`question` must be a string.",
      mcpUrl: input.mcpUrl ?? null,
    };
  }
  const question = (input.question ?? "").trim() || DEFAULT_QUESTION;
  const raw =
    input.mcpUrl !== undefined
      ? input.mcpUrl
      : (configuredUrl ?? DEFAULT_MCP_URL);
  const mcpUrl = parseMcpUrl(raw);
  if (!mcpUrl) {
    return {
      ok: false,
      reason: "`mcpUrl` must be an absolute https URL.",
      mcpUrl: raw ?? null,
    };
  }
  return { ok: true, question, mcpUrl };
}

/**
 * The MCP server entry for `models.launch`. The bearer token goes only to the
 * origin of the configured `MCP_URL`; any other server gets no credentials.
 */
export function mcpFor(
  mcpUrl: string,
  token: string | undefined,
  configuredUrl: string | undefined,
): ModelMcp {
  const configured = parseMcpUrl(configuredUrl);
  const sameOrigin =
    configured !== null &&
    new URL(configured).origin === new URL(mcpUrl).origin;
  return token && sameOrigin
    ? { url: mcpUrl, headers: { authorization: `Bearer ${token}` } }
    : { url: mcpUrl };
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
  async run(input: { question?: unknown; mcpUrl?: unknown }, ctx: Ctx) {
    const read = readInput(input, process.env.MCP_URL);
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
    const mcp = mcpFor(mcpUrl, process.env.MCP_AUTH_TOKEN, process.env.MCP_URL);
    // Recorded from the request actually sent, so `report` cannot disagree with it.
    ctx.shared.set("authenticated", mcp.headers !== undefined);

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
    const read = readRun(run);
    if (!read.ok) return fail(read.reason);
    const { answer } = read;

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

/** Terminal off-ramp for unusable input. */
const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(input: { reason: string; mcpUrl: unknown }) {
    return terminate({ rejected: true, ...input });
  },
});

export const agent = defineAgent({
  name: "managed-loop-with-mcp",
  entry: "prepare",
  steps: { prepare, ask, report, rejected },
});
