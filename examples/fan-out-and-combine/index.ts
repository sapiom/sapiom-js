import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { z } from "zod/v4";

/**
 * Fan Out and Combine — split a goal into parts, run each part as its own child
 * agent run in parallel, then merge the results into one answer.
 *
 * This is the canonical "an agent composes other agents" template. It reaches
 * the child-run capability through the run context (`ctx.sapiom.agents.run`), so
 * every child is a real, independently-metered agent run — not an in-process
 * function call. The pattern is fan-out → join → reduce, the durable equivalent of
 * `Promise.all` over sub-agents.
 *
 * ONE agent, TWO roles, chosen by `mode`:
 *   - coordinate (default): the parent. Splits the goal into items, launches a
 *     child run per item, waits for all of them, and reduces their outputs.
 *   - leaf: a child. Does exactly ONE unit of work (analyse its item toward the
 *     goal with `models.run`) and terminates. A leaf NEVER fans out, which is what
 *     bounds the recursion to a single level — there is no runaway.
 *
 * The child it fans out to defaults to THIS agent's own slug (`ctx.agentName`), so
 * the template composes itself with zero setup: a deployed run dispatches leaf runs
 * of the same deployment. Point `childDefinition` at any other deployed
 * agent's slug and it fans that out instead, one child run per item.
 *
 * The graph, one legible line per role:
 *   plan ─▶ fanOut (agents.run × N) ─▶ reduce (models.run) ─▶ done      (coordinate)
 *   plan ─▶ solve (models.run) ─▶ (terminal)                            (leaf)
 *   plan ─▶ planned (terminal)                                          (dryRun)
 *
 * Never-fail discipline:
 *   - Every child dispatch is wrapped: a child that throws or ends non-`completed`
 *     becomes a `{ ok: false }` row, and the reduce runs over the survivors. Even
 *     if every child fails, the run still reaches a terminal state with an honest
 *     account of what happened — it never reports a combined answer it doesn't have.
 *   - `dryRun` returns the resolved fan-out PLAN (which child, how many items, the
 *     resolved inputs) without dispatching anything. Pass it to `run_local` to see
 *     the fan-out shape with no Sapiom capability spend before spending on child runs.
 *   - During `run_local` the child capability is stubbed, so children complete
 *     with empty output; the reduce says so rather than inventing analysis.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Hard cap on how many children a single coordinate run fans out to. */
const MAX_ITEMS = 5;
/** Truncate each child's analysis before it rides into the reduce prompt. */
const MAX_ANALYSIS_CHARS = 1200;
/** Bound the leaf model call — one focused analysis, not an essay. */
const LEAF_MAX_TOKENS = 700;
/** Bound the reduce model call — a combined brief, not a book. */
const REDUCE_MAX_TOKENS = 1000;

/**
 * The goal a zero-input run works on. A real goal with real sub-parts, so the
 * default run produces a genuine combined answer rather than a hollow demo.
 */
const DEFAULT_GOAL =
  "What are the main trade-offs of running background jobs on a serverless platform?";
/** The sub-parts a zero-input run fans out — one child run each. */
const DEFAULT_ITEMS = [
  "cost and the billing model",
  "cold starts and latency",
  "concurrency and scaling limits",
];

// ─────────────────────────────────────────────────────────────── shapes ──
type Mode = "coordinate" | "leaf";

interface EntryInput {
  /** What to accomplish. Split across the items on the coordinate path. */
  goal?: string;
  /** The sub-parts to fan out — one child run per item. Defaults to a sample set. */
  items?: string[];
  /**
   * Slug of the deployed agent to run for each item. Defaults to THIS
   * agent's own slug, so the template composes itself with no other deployment.
   */
  childDefinition?: string;
  /**
   * Which role this agent run plays. Omit (or "coordinate") for the parent; the
   * coordinator sets "leaf" on the children it launches. A leaf does one item and
   * never fans out.
   */
  mode?: Mode;
  /** The single item a leaf works on. Set by the coordinator on each child. */
  item?: string;
  /** Resolve and return the fan-out plan without dispatching any child runs. */
  dryRun?: boolean;
}

/** The outcome of one child dispatch, success or failure — the fan-out → reduce row. */
interface ChildResult {
  item: string;
  /** True only when the child run reached `completed`. */
  ok: boolean;
  /** The child run's lifecycle status, or "error" when the dispatch itself threw. */
  status: string;
  /** The child's analysis text, when it returned one. */
  analysis: string | null;
  /** A short error string when the child failed or threw. */
  error: string | null;
}

interface Shared extends Record<string, unknown> {
  goal: string;
  childDefinition: string;
  dryRun: boolean;
  /** How many items the coordinator fanned out (0 on the leaf/dryRun paths). */
  itemCount: number;
  /** Set when the run coordinated the default goal rather than a supplied one. */
  note?: string;
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
/** Trim, drop empties, de-dupe, and cap — the items a coordinate run fans out. */
function normalizeItems(items: unknown, fallback: string[]): string[] {
  const cleaned = Array.isArray(items)
    ? [
        ...new Set(
          items
            .filter((i): i is string => typeof i === "string")
            .map((i) => i.trim())
            .filter((i) => i.length > 0),
        ),
      ]
    : [];
  const chosen = cleaned.length > 0 ? cleaned : fallback;
  return chosen.slice(0, MAX_ITEMS);
}

/** A short, human-readable reason a child run did not complete. */
function describeChildError(error: unknown, status: string): string {
  if (error == null) return `child ended in status "${status}"`;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}

/**
 * Pull the leaf's analysis text out of a child run's output. A leaf terminates with
 * `{ analysis }`, but a custom `childDefinition` may shape its output differently
 * (and the offline stub returns `{}`), so read defensively and return null rather
 * than throw when there is nothing to read.
 */
function readAnalysis(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const value = (output as Record<string, unknown>).analysis;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, MAX_ANALYSIS_CHARS)
    : null;
}

// ─────────────────────────────────────────────────────────────── steps ──
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `goal` and `items` carry the
 * sample set as their `.default(...)` so a zero-input run really fans out;
 * `mode`/`item` are what the coordinator sets on each child.
 */
const entryInput = z.object({
  goal: z
    .string()
    .default(DEFAULT_GOAL)
    .describe(
      "What to accomplish. Split across the items on the coordinate path.",
    ),
  items: z
    .array(z.string())
    .default(DEFAULT_ITEMS)
    .describe("The sub-parts to fan out — one child run per item."),
  childDefinition: z
    .string()
    .optional()
    .describe(
      "Slug of the deployed agent to run per item. Defaults to this agent's own slug.",
    ),
  mode: z
    .enum(["coordinate", "leaf"])
    .default("coordinate")
    .describe(
      'Which role this agent run plays; a "leaf" does one item and never fans out.',
    ),
  item: z
    .string()
    .optional()
    .describe(
      "The single item a leaf works on. Set by the coordinator on each child.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Resolve and return the fan-out plan without dispatching any child runs.",
    ),
});

const plan = defineStep({
  name: "plan",
  inputSchema: entryInput,
  next: ["solve", "fanOut", "planned"],
  async run(input: EntryInput, ctx: Ctx) {
    const mode: Mode = input.mode === "leaf" ? "leaf" : "coordinate";
    // The schema fills `goal` with DEFAULT_GOAL on a zero-input run, so the
    // value — not its absence — is what tells us the default goal was used.
    const goal = input.goal?.trim() || DEFAULT_GOAL;
    // Default to composing THIS deployment. `ctx.agentName` is the run's own slug,
    // so a forked+deployed copy dispatches leaf runs of itself with no other setup.
    const childDefinition = input.childDefinition?.trim() || ctx.agentName;

    ctx.shared.set("goal", goal);
    ctx.shared.set("childDefinition", childDefinition);
    ctx.shared.set("dryRun", input.dryRun === true);
    ctx.shared.set("itemCount", 0);

    // Leaf path: one item, one analysis, no fan-out. This is what each child runs.
    if (mode === "leaf") {
      const item = input.item?.trim() || goal;
      return goto("solve", { goal, item });
    }

    // Coordinate path.
    const items = normalizeItems(input.items, DEFAULT_ITEMS);
    ctx.shared.set("itemCount", items.length);
    if (goal === DEFAULT_GOAL) {
      ctx.shared.set(
        "note",
        `Coordinated the default goal. Pass a \`goal\` and \`items\` to fan out your own.`,
      );
    }

    // Dry run: describe the fan-out without dispatching a single child.
    if (input.dryRun === true) {
      return goto("planned", { goal, childDefinition, items });
    }

    ctx.logger.info("fanning out", {
      goal,
      childDefinition,
      items: items.length,
    });
    return goto("fanOut", { goal, childDefinition, items });
  },
});

const solve = defineStep({
  name: "solve",
  next: [],
  terminal: true,
  async run(input: { goal: string; item: string }, ctx: Ctx) {
    // The unit of work a child does. One model call, one focused result. A leaf
    // deliberately does NOT fan out — that is what keeps the recursion one level deep.
    const res = await ctx.sapiom.models.run({
      system:
        "You are one worker in a parallel team, each analysing a different facet " +
        "of the same goal. Analyse ONLY your assigned facet, concretely and " +
        "self-containedly, in 3-5 sentences. Do not restate the goal or the other " +
        "facets — another step combines everyone's work.",
      prompt: `GOAL: ${input.goal}\n\nYOUR FACET: ${input.item}`,
      maxTokens: LEAF_MAX_TOKENS,
    });
    const analysis = (res?.output ?? "").trim();
    ctx.logger.info("leaf solved its facet", {
      item: input.item,
      chars: analysis.length,
    });
    return terminate({ ok: true, item: input.item, analysis });
  },
});

const fanOut = defineStep({
  name: "fanOut",
  next: ["reduce"],
  async run(
    input: { goal: string; childDefinition: string; items: string[] },
    ctx: Ctx,
  ) {
    const { goal, childDefinition, items } = input;

    // Launch one child run per item and wait for all of them — the durable
    // equivalent of Promise.all over sub-agents. `agents.run` blocks until the
    // child reaches a terminal state, so a rejected promise here is a genuine
    // dispatch failure, caught per-item so one bad child never sinks the batch.
    const results = await Promise.all(
      items.map(async (item): Promise<ChildResult> => {
        try {
          const run = await ctx.sapiom.agents.run({
            definition: childDefinition,
            // A self-child reads `mode`; a custom child just gets goal + item.
            input: { mode: "leaf", goal, item },
          });
          const ok = run.status === "completed";
          return {
            item,
            ok,
            status: run.status,
            analysis: ok ? readAnalysis(run.output) : null,
            error: ok ? null : describeChildError(run.error, run.status),
          };
        } catch (err) {
          // A dispatch that throws (unknown slug, transport fault) is data, not a
          // crash: record it and let the survivors carry the run.
          ctx.logger.warn("child dispatch failed", {
            item,
            childDefinition,
            err: String(err),
          });
          return {
            item,
            ok: false,
            status: "error",
            analysis: null,
            error: String(err),
          };
        }
      }),
    );

    const succeeded = results.filter((r) => r.ok).length;
    ctx.logger.info("fan-out joined", {
      total: results.length,
      succeeded,
    });
    return goto("reduce", { results });
  },
});

const reduce = defineStep({
  name: "reduce",
  next: ["done"],
  async run(input: { results: ChildResult[] }, ctx: Ctx) {
    const results = input.results ?? [];
    const goal = ctx.shared.get("goal") || DEFAULT_GOAL;
    const withAnalysis = results.filter((r) => r.ok && r.analysis);

    // Nothing came back with content — the honest combined answer says so, no
    // model call needed. Reached when every child failed, or offline where the
    // child capability is stubbed and returns empty output.
    if (withAnalysis.length === 0) {
      const combined =
        `No child run returned analysis for "${goal}" ` +
        `(${results.length} dispatched, ${results.filter((r) => r.ok).length} completed). ` +
        `Offline this is expected — the child capability is stubbed.`;
      return goto("done", { combined, results });
    }

    const parts = withAnalysis
      .map((r, i) => `[${i + 1}] FACET: ${r.item}\n${r.analysis}`)
      .join("\n\n");

    // Combine the children's independent analyses into one answer. Wrapped so a
    // reduce failure still terminates with the raw parts rather than sinking a run
    // whose expensive fan-out already succeeded.
    let combined: string;
    try {
      const res = await ctx.sapiom.models.run({
        system:
          "You are combining several workers' independent analyses, each covering " +
          "a different facet of one goal, into a single coherent answer. Integrate " +
          "them — resolve overlaps, keep the concrete detail, and note any tension " +
          "between facets. Do not just concatenate. Output prose, no preamble.",
        prompt: `GOAL: ${goal}\n\nFACET ANALYSES:\n${parts}`,
        maxTokens: REDUCE_MAX_TOKENS,
      });
      combined = (res?.output ?? "").trim();
      if (!combined) throw new Error("empty reduce output");
    } catch (err) {
      ctx.logger.warn("reduce model call failed; returning the raw facets", {
        err: String(err),
      });
      combined =
        `Combined ${withAnalysis.length} facet analyses (synthesis step ` +
        `unavailable, so they are listed as-is):\n\n${parts}`;
    }

    ctx.logger.info("reduced", { facets: withAnalysis.length });
    return goto("done", { combined, results });
  },
});

const done = defineStep({
  name: "done",
  next: [],
  terminal: true,
  async run(input: { combined: string; results: ChildResult[] }, ctx: Ctx) {
    const results = input.results ?? [];
    const succeeded = results.filter((r) => r.ok).length;
    return terminate({
      coordinated: true,
      dispatched: results.length > 0,
      goal: ctx.shared.get("goal") || DEFAULT_GOAL,
      childDefinition: ctx.shared.get("childDefinition") || null,
      combined: input.combined,
      children: results.map((r) => ({
        item: r.item,
        ok: r.ok,
        status: r.status,
        error: r.error,
      })),
      succeeded,
      total: results.length,
      note: ctx.shared.get("note"),
    });
  },
});

const planned = defineStep({
  name: "planned",
  next: [],
  terminal: true,
  async run(
    input: { goal: string; childDefinition: string; items: string[] },
    ctx: Ctx,
  ) {
    // The off-ramp: describe exactly what a real run WOULD dispatch, having spent
    // nothing. Honest — `dispatched: false` — and real: a concrete fan-out plan.
    return terminate({
      coordinated: false,
      dispatched: false,
      dryRun: true,
      goal: input.goal,
      childDefinition: input.childDefinition,
      plan: {
        childRuns: input.items.length,
        items: input.items,
        inputs: input.items.map((item) => ({
          mode: "leaf",
          goal: input.goal,
          item,
        })),
      },
      note: [
        "`dryRun` was set, so no child runs were dispatched.",
        ctx.shared.get("note"),
      ]
        .filter(Boolean)
        .join(" "),
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "fan-out-and-combine",
  entry: "plan",
  steps: {
    plan,
    solve,
    fanOut,
    reduce,
    done,
    planned,
  },
});
