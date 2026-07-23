# Eval Gate

An **LLM-judge quality gate**. Score an output against **your** rubric, then gate
the next step on the score. This is the template for **building your own evals** —
you bring the rubric, we own the harness.

The eval-gate is **not a capability**. Decomposed, it's a reference agent built
from primitives you already have:

| Piece                  | What it is                                             | Primitive                      |
| ---------------------- | ------------------------------------------------------ | ------------------------------ |
| Score an output        | one LLM call with a judge prompt → a number            | `ctx.sapiom.models.run`        |
| Branch on the score    | `score >= threshold ? publish : revise`                | engine control flow            |
| Build the judge prompt | string templating from **your** rubric + a score parse | `judge.ts` (the only new code) |

## What it does

```
judge ─▶ gate ─┬─▶ publish   (score >= threshold)
               └─▶ revise    (score <  threshold)
```

1. **judge** (entry) — validates input against a zod schema, builds the judge
   prompt from **your** rubric, calls the LLM via `ctx.sapiom.models.run`, and
   parses a `[0,1]` score from the reply. A malformed reply throws, so the engine
   retries.
2. **gate** — pure branch, no capability call: `score >= threshold` ⇒ `publish`,
   else `revise`.
3. **publish** / **revise** (terminal) — return `{ decision, score, threshold,
rationale }`. **You** decide what "publish" and "revise" mean.

Input contract: `{ input, output, rubric, threshold=0.7, model? }`.

- `input` — the case the output was produced from (task, prompt, question).
- `output` — the thing being graded.
- `rubric` — **your** criteria string. The judge scores against this.
- `threshold` — the pass bar in `[0,1]` (default `0.7`).
- `model` — optional judge-model alias.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the `judge` step
   inherits that authority to call the model.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (the `models.run`
   capability is stubbed, free) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run` (a real, **billed** judge
   call that meters `models.run`).

### Tracing both branches offline (run_local)

`run_local` resolves `ctx.sapiom.models.run` from a stub. The _default_ stub
returns a non-numeric placeholder, and `parseScore` throws on a reply with no
number (by design), so supply a **stub score** to trace the graph — and flip it
to see each branch:

```jsonc
// high score → gate → publish
{ "version": 1, "steps": { "judge": {
  "models.run": { "output": "{\"score\":0.9,\"rationale\":\"meets the rubric\"}" }
} } }

// low score → gate → revise
{ "version": 1, "steps": { "judge": {
  "models.run": { "output": "{\"score\":0.4,\"rationale\":\"misses the rubric\"}" }
} } }
```

Run `npm run typecheck` to confirm it compiles (and that every `ctx.sapiom.*`
method you used exists).

## Build your own eval

The rubric is yours; everything else is scaffolding. To adapt this into a real
eval, change three things:

- **The rubric** — the criteria the judge scores against. Pass it as the `rubric`
  input. This is where all your opinion about "quality" lives; we ship none.
  Example: `"Cites at least one source, no unsupported claims, under 200 words."`
- **The threshold** — the pass bar in `[0,1]` (default `0.7`). Raise it to be
  stricter about what reaches `publish`; lower it to let more through.
- **The judge model** — pass `model` (a models alias the gateway knows) to pick a
  cheaper/stronger judge. Leave it unset for the configured default.

The judge prompt and score parser live in `judge.ts` (`buildJudgePrompt` +
`parseScore`) — the only genuinely new code. `parseScore` prefers a JSON
`{score, rationale}`, falls back to a bare number, clamps to `[0,1]`, and
tolerates a model that answered on a 0–100 scale. Override the **rubric**, not
this scaffolding.

## Self-grading composition (call it as a child)

Because the eval-gate is a deployable agent, a **parent** workflow can grade its
own output by launching the eval-gate as a **child** and branching on the
returned decision — the canonical self-grading-workflow pattern:

```
parent.produce ─▶ parent.grade ─(POST /v1/workflows/executions)─▶ eval-gate child
                                ─(pauseUntilSignal, $0 while idle)─▶ decision ─┬─▶ ship
                                                                              └─▶ regenerate
```

The parent produces an output, POSTs a child eval-gate execution, then **pauses
at $0** until the child's decision arrives as a signal. A `dryRun` guard keeps
`run_local` offline and free. Sketch of the parent (a separate agent you'd
author alongside your workflow):

```ts
import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/** The signal the child's decision is delivered on, correlated by executionId. */
const CHILD_DONE = "eval.child.done";

interface Shared extends Record<string, unknown> {
  output: string;
}

/** The eval-gate child's terminal output — what the resumed step receives. */
interface EvalDecision {
  decision: "publish" | "revise";
  score: number;
  threshold: number;
  rationale: string;
}

const produce = defineStep({
  name: "produce",
  next: ["grade"],
  async run(input: { brief: string }, ctx: AgentExecutionContext<Shared>) {
    const res = await ctx.sapiom.models.run({
      prompt: input.brief,
      maxTokens: 400,
    });
    const output = res.output ?? "";
    ctx.shared.set("output", output);
    return goto("grade", { brief: input.brief, output });
  },
});

const grade = defineStep({
  name: "grade",
  next: [],
  // Static graph edge: on CHILD_DONE, resume at `decision`.
  pause: { signal: CHILD_DONE, resumeStep: "decision" },
  async run(
    input: { brief: string; output: string },
    ctx: AgentExecutionContext<Shared>,
  ) {
    // Offline unless there's a real API key (or DRY_RUN forces it off).
    const dryRun = !process.env.SAPIOM_API_KEY || process.env.DRY_RUN === "1";
    const childInput = {
      input: input.brief,
      output: input.output,
      rubric: "Accurate, on-brief, and free of unsupported claims.",
      threshold: 0.7,
    };
    if (!dryRun) {
      // Launch the deployed eval-gate as a child. Raw HTTP — NOT a capability
      // namespace, and NOT ctx.sapiom.agents.launch (which 404s in prod).
      await fetch("https://api.sapiom.ai/v1/workflows/executions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.SAPIOM_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          definitionId: process.env.EVAL_GATE_DEFINITION_ID,
          input: childInput,
          idempotencyKey: ctx.executionId,
        }),
      });
    }
    // Suspend at $0 until the child's decision fires CHILD_DONE for this run.
    return pauseUntilSignal({
      signal: CHILD_DONE,
      resumeStep: "decision",
      correlationId: ctx.executionId,
    });
  },
});

const decision = defineStep({
  name: "decision",
  next: ["ship", "regenerate"],
  // The signal payload IS the eval-gate child's terminal output.
  async run(child: EvalDecision, ctx: AgentExecutionContext<Shared>) {
    ctx.logger.info("child graded", {
      decision: child.decision,
      score: child.score,
    });
    return child.decision === "publish"
      ? goto("ship", {})
      : goto("regenerate", {});
  },
});

const ship = defineStep({
  name: "ship",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    return terminate({ shipped: ctx.shared.get("output") });
  },
});

const regenerate = defineStep({
  name: "regenerate",
  next: [],
  terminal: true,
  async run(_input: unknown, _ctx: AgentExecutionContext<Shared>) {
    // ...loop back to produce with the rationale, or hand off for human review.
    return terminate({ shipped: null, action: "regenerate" });
  },
});

export const agent = defineAgent<{ brief: string }, Shared>({
  name: "self-grading-writer",
  entry: "produce",
  steps: { produce, grade, decision, ship, regenerate },
});
```

The child's terminal output (`{ decision, score, threshold, rationale }`) is
delivered as `decision`'s input via the `CHILD_DONE` signal, correlated by the
parent's `executionId`. In dev you fire that signal yourself via the MCP
`signal_workflow` / `workflow_signal` tool once the child run finishes — the same
manual stand-in the Wait-for-Webhook template uses:

```json
{
  "signal": "eval.child.done",
  "correlationId": "<parent executionId>",
  "payload": {
    "decision": "publish",
    "score": 0.9,
    "threshold": 0.7,
    "rationale": "…"
  }
}
```

## Files

- `index.ts` — the eval-gate agent (edit this).
- `judge.ts` — `buildJudgePrompt` + `parseScore`, the only new logic.
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.
- `AGENTS.md` — the authoring loop and the composition contract.
