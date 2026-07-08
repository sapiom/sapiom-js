---
name: sapiom-agent-authoring
description: Build, test, and deploy a Sapiom agent — a controlled, multi-step,
  deployable automation defined in TypeScript. Use when the user wants to
  automate a multi-step, scheduled, recurring, or deployable task ("build an
  agent that checks competitor prices every morning", "automate our weekly
  report", "make a bot that reviews PRs"), or names Sapiom, defineAgent,
  @sapiom/agent, or the sapiom-dev MCP. Also use to run, inspect, or resume an
  existing Sapiom agent. Do NOT use for a single one-off capability call
  (a web search, one scrape, one image) with no automation to keep — use
  Sapiom's remote MCP or SDK for that.
---

# Building Sapiom Agents

A Sapiom **agent** is a small TypeScript project you author with your coding agent: a
`defineAgent({ name, entry, steps })` where each step's `run(input, ctx)` does work — calling
paid Sapiom capabilities through the typed `ctx.sapiom.*` client — and returns a directive.
You test it locally for free, then deploy it to run on Sapiom's cloud: on demand, on a
schedule, or resumed by signals. All from the terminal; no dashboard required.

**Load this skill before scaffolding — it drives the whole lifecycle from zero.** Inside a
scaffolded project, `AGENTS.md` is the quick reference; this skill is the deep guide.

## If the Sapiom dev MCP isn't connected yet

The lifecycle below runs through the **sapiom-dev** MCP server (`@sapiom/mcp`). If its tools
(`sapiom_authenticate`, `sapiom_dev_agents_*`) aren't available, add the server first:

```bash
claude mcp add sapiom -- npx -y @sapiom/mcp
```

Other clients: run `npx -y @sapiom/mcp` as a local (stdio) MCP server — see
[docs.sapiom.ai](https://docs.sapiom.ai/integration/mcp-servers/setup) for per-client config.

## Lifecycle from Zero

### 1. Authenticate (required before deploy/run)

Run `sapiom_authenticate` — it opens a browser login and caches an API key in
`~/.sapiom/credentials.json`. Confirm with `sapiom_status`. This makes your coding agent an
API-key principal; deployed agents inherit that authority to call paid capabilities.

### 2. Scaffold

Call `sapiom_dev_agents_scaffold` with a target directory. The scaffold writes:

```
my-agent/
├── index.ts            # your agent definition (edit this)
├── AGENTS.md           # quick in-project reference
├── CLAUDE.md           # points your coding agent at AGENTS.md
├── .claude/skills/     # this skill, locally — the deep guide
├── .sapiom-dev/stubs.json
├── package.json / tsconfig.json / ...
```

Install deps: `npm install`. Templates: `"default"` (minimal two-step starter) or
`"coding-pause"` (launch + pause/resume coding-model pattern).

### 3. Write steps → typecheck → check → run_local → deploy

| Command | What it does |
|---|---|
| `npm run typecheck` | Confirms types compile and every `ctx.sapiom.*` call exists |
| `sapiom_dev_agents_check` | Bundles `index.ts` + validates the step graph (offline, instant) |
| `sapiom_dev_agents_run_local` | Runs real step code with all capabilities stubbed — free, no spend |

Then ship:

| Command | What it does |
|---|---|
| `sapiom_dev_agents_link` | Registers the agent under your tenant |
| `sapiom_dev_agents_deploy` | Builds and deploys to Sapiom's cloud |
| `sapiom_dev_agents_run` | Starts a real (billed) execution |
| `sapiom_dev_agents_inspect` | Watch an execution's status, steps, and spend |

## The Step Model — Hard Rules

### Canonical API

| Import | From |
|---|---|
| `defineAgent` | `@sapiom/agent` |
| `defineStep` | `@sapiom/agent` |
| `goto / terminate / fail / retry / pauseUntilSignal` | `@sapiom/agent` |
| `AgentExecutionContext` | `@sapiom/agent` |
| `CODING_RESULT_SIGNAL / CodingResultPayload` | `@sapiom/tools` |

**NEVER use `defineWorkflow`, `defineOrchestration`, `@sapiom/workflow-sdk`, or
`@sapiom/orchestration`** — those are stale names. The correct package is `@sapiom/agent`.

### `defineAgent` shape

```typescript
export const agent = defineAgent({
  name: "my-agent",      // string — used for logging and inspect
  entry: "start",        // must name a key in steps
  steps: { start, finish },
});
```

Export exactly one `defineAgent(...)` from `index.ts`.

### `defineStep` fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | `string` | yes | Step's id; must match its key in the steps object |
| `next` | `readonly string[]` | yes | Step names this step may `goto`. Empty array if terminal |
| `terminal` | `boolean` | no | `true` if this step ends the agent's execution |
| `canFail` | `boolean` | no | Must be `true` to return `fail()` |
| `pause` | `{ signal, resumeStep }` | no | Required when returning `pauseUntilSignal(...)` |
| `inputSchema` | `ZodType` | no | Zod schema validating this step's input |
| `timeoutMs` | `number` | no | Per-step timeout; no automatic retry cap |
| `run(input, ctx)` | `async function` | yes | Returns a directive |

Import Zod via the `zod/v4` subpath — `import { z } from "zod/v4"` — to match the SDK's
schema types. Don't import from bare `"zod"` or add a second zod dependency.

### Directives — what `run` must return

| Directive | Function | Constraint |
|---|---|---|
| `goto(target, output?)` | Advance to another step | `target` must be in `next[]` |
| `terminate(output?, opts?)` | End the execution successfully | Step must have `terminal: true` |
| `fail(reason?, opts?)` | End the execution as failed | Step must have `canFail: true` |
| `retry(opts?)` | Re-run this step | Bound with `ctx.attempts` — no automatic cap |
| `pauseUntilSignal(handle, opts?)` | Suspend until a signal fires | Step must declare `pause: { signal, resumeStep }` |

TypeScript enforces these constraints at compile time — a `terminate` in a non-terminal step,
or a `fail` without `canFail: true`, is a type error.

### Minimal two-step example

```typescript
import { defineAgent, defineStep, goto, terminate } from "@sapiom/agent";

const start = defineStep({
  name: "start",
  next: ["finish"],
  async run(input: { name: string }, ctx) {
    ctx.logger.info("got input", { name: input.name });
    return goto("finish", { greeting: `Hello, ${input.name}` });
  },
});

const finish = defineStep({
  name: "finish",
  next: [],
  terminal: true,
  async run(input: { greeting: string }, ctx) {
    return terminate({ result: input.greeting });
  },
});

export const agent = defineAgent({
  name: "greet",
  entry: "start",
  steps: { start, finish },
});
```

## Cross-Step State with `ctx.shared`

`goto(target, payload)` passes data to the next step's `input`. For data multiple downstream
steps need, use `ctx.shared` — a typed key/value store that persists across the whole execution.

```typescript
interface Shared extends Record<string, unknown> {
  taskId: string;
}

// In a step:
ctx.shared.set("taskId", "abc-123");

// In a later step:
const taskId = ctx.shared.get("taskId"); // typed as string | undefined
```

`ctx.shared` API: `get(key)`, `set(key, value)`, `has(key)`, `snapshot()`.

**A step's `run(input, ctx)` first argument is its inbound input** — the entry input at the
entry step, or the previous step's `goto(target, payload)` value at later steps. The entry
input reaches only the entry step's argument; to use it in later steps, write it into
`ctx.shared` from the entry step.

## `ctx` Reference

| Field | Type | Notes |
|---|---|---|
| `ctx.executionId` | `string` | Unique id for this execution |
| `ctx.workflowName` | `string` | The agent's `name` (field name predates the rename) |
| `ctx.input` | `unknown` | The execution's entry input — same value the entry step's `run` arg receives. Use `ctx.shared` to carry it forward; don't rely on `ctx.input` downstream. |
| `ctx.shared` | `TypedContextStore<TShared>` | Cross-step key/value store |
| `ctx.history` | `readonly StepExecutionRecord[]` | Previous steps' records |
| `ctx.attempts` | `number` | How many times this step has run (0-indexed) |
| `ctx.logger` | `StepLogger` | `info / warn / error / debug(msg, meta?)` |
| `ctx.sapiom` | `Sapiom` | The typed capability client — see "Capabilities" below |
| `ctx.organizationId` | `string \| null` | Tenant org |
| `ctx.tenantId` | `string \| null` | Tenant id |

## Capabilities from Steps

Steps call Sapiom's paid capabilities through `ctx.sapiom.*` — sandboxes, repositories,
coding models (`ctx.sapiom.models.coding`), file storage, content generation, search,
databases, email, domains, memory, and more as they land. **Do not memorize the catalog:
types are the source of truth.** `ctx.sapiom.` autocompletes what exists, `npm run typecheck`
rejects what doesn't, and the full catalog with pricing lives at
[docs.sapiom.ai/capabilities](https://docs.sapiom.ai/capabilities).

## Failure Handling & Retries

There is no automatic per-step retry. Express it explicitly — this keeps the graph readable.
The common pattern is a bounded loop that escalates:

```typescript
const reconsider = defineStep({
  name: "reconsider",
  next: ["work", "escalate"],
  async run(_input, ctx: AgentExecutionContext<{ attempt: number }>) {
    const attempt = ctx.shared.get("attempt") ?? 0;
    if (attempt >= 3) return goto("escalate", {});
    ctx.shared.set("attempt", attempt + 1);
    return goto("work", {});
  },
});
```

For a step's own retries (transient errors):

```typescript
async run(input, ctx) {
  try {
    const result = await ctx.sapiom.sandboxes.create({ name: "demo" });
    return terminate({ result });
  } catch (err) {
    // ctx.attempts is 0-indexed: `+ 1 < N` gives exactly N total attempts.
    // (`ctx.attempts < N` would run N+1 times — a common off-by-one.)
    if (ctx.attempts + 1 < 3) return retry({ delayMs: 1000 });
    return fail("too many attempts");  // requires canFail: true
  }
}
```

`timeoutMs` on a step caps how long its `run` may take. There is no engine-level retry cap —
you own the bound.

## Pause & Resume (Long-Running Dispatched Steps)

A step's `run` completes in one synchronous dispatch. For long-running capabilities (a
dispatched coding-model run), **launch fire-and-forget and pause** — the engine suspends the
execution until the result signal fires, then resumes into a designated step whose `input`
IS the result payload.

```typescript
import {
  defineAgent, defineStep, goto, pauseUntilSignal, terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { CODING_RESULT_SIGNAL, type CodingResultPayload } from "@sapiom/tools";

interface Shared extends Record<string, unknown> {
  repoSlug: string;
}

const launch = defineStep({
  name: "launch",
  next: ["collect"],
  // Declare the signal and resume step so the engine knows what to wait for.
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "collect" },
  async run(input: { task: string }, ctx: AgentExecutionContext<Shared>) {
    const repo = await ctx.sapiom.repositories.create("my-repo");
    ctx.shared.set("repoSlug", repo.slug);               // stash before pausing
    const run = await ctx.sapiom.models.coding.launch({ task: input.task, gitRepository: repo });
    return pauseUntilSignal(run, { resumeStep: "collect" }); // pass the handle, not the signal name
  },
});

const collect = defineStep({
  name: "collect",
  next: [],
  terminal: true,
  // input IS the CodingResultPayload delivered by the resume signal.
  async run(result: CodingResultPayload, ctx: AgentExecutionContext<Shared>) {
    if (result.status !== "completed") {
      return terminate({ status: result.status, error: result.error });
    }
    // Re-attach the sandbox — the payload crossed a wire boundary, so there are no live handles.
    if (result.executionEnvironment?.type === "blaxel_sandbox") {
      const sandbox = ctx.sapiom.sandboxes.attach(result.executionEnvironment.id);
      // … push from sandbox, read files, etc.
    }
    return terminate({ status: result.status, summary: result.summary });
  },
});

export const agent = defineAgent<{ task: string }, Shared>({
  name: "code-and-collect",
  entry: "launch",
  steps: { launch, collect },
});
```

Key rules:

- `pause: { signal, resumeStep }` is **required** on the step that returns `pauseUntilSignal`.
  Passing the handle to `pauseUntilSignal(handle, ...)` wires the signal automatically.
- The **resumed step's `input` is the run's result payload** (`CodingResultPayload`).
  Annotate it explicitly — don't hand-roll the shape.
- The payload crossed a process boundary: **no live handles**. Re-attach a sandbox from
  `result.executionEnvironment.id` if needed; stash everything else in `ctx.shared` before pausing.
- For a **manual human-gate** (no capability handle), use the object form and fire the signal
  from your approval flow:

```typescript
return pauseUntilSignal({
  signal: "my.approval",
  resumeStep: "finalize",
  correlationId: ctx.executionId,  // makes the awaited signal unique to this execution
});
```

Under `run_local`, a dispatch pause auto-resumes with the stub result; a manual gate
auto-resumes with `{}` unless stubbed — type the resumed step's input with optional fields
accordingly.

## Determinism

A step body runs **once** on the happy path. It re-runs only on retry (after a throw or
`retry()`). Do not rely on a value being recomputed identically across a pause/resume or a
retry. Capture non-deterministic values (timestamps, random ids) once and carry them forward
via `goto` input or `ctx.shared`.

## Testing with `run_local` and Stubs

`run_local` works with **no stubs** — capabilities return sensible defaults. Add
`.sapiom-dev/stubs.json` overrides only when a step branches on a specific result:

```jsonc
{
  "version": 1,
  "steps": {
    // Stub the coding run under the LAUNCHING step (here `launch`), not the resume step.
    "launch": {
      "models.coding.run": { "status": "completed", "summary": "done", "result": null, "error": null, "executionEnvironment": null }
    },
    "check": {
      "repositories.list": [{ "slug": "my-repo", "cloneUrl": "https://..." }]
    }
  }
}
```

Stub naming rules:

- Namespace calls use the **plural/namespace path**: `repositories.list`, `models.coding.run`.
- Handle method calls use the **singular**: `repository.pushFromSandbox`, `sandbox.exec`.
- To stub a coding run's resume payload, override `models.coding.run` (or
  `models.coding.launch`) in the **launching step** — that value is both the inline result
  and the payload the paused step resumes with.
- `run_local` reports `unusedStubs` (key matched nothing — usually a typo or plural/singular
  slip) and `stubWarnings` (key matched but wrong shape). A green run with either non-empty
  means the stub silently didn't apply.
- **Local retry cap:** the `run_local` tool defaults to `maxAttemptsPerStep: 3`. If a step's
  own retry bound allows ≥3 retries, pass a higher `maxAttemptsPerStep` so the local harness
  doesn't stop the loop before your `fail()` fires. This cap is local-test only — production
  has no engine-level retry cap.

Write each step the way it should run in production — never weaken logic to shape a local run.

## Tips

- **Types are the source of truth.** What's on `ctx.sapiom` is defined by `@sapiom/tools`.
  Use autocomplete and `npm run typecheck` rather than guessing — a wrong capability name is
  a type error, not a runtime surprise.
- **`check` before deploy.** It validates the step graph (names, `next` references,
  `terminal` consistency) — a misconfigured graph is caught here, not at runtime.
- **One `defineAgent` export per file.** The scaffold wraps a single `index.ts`.
- **`ctx.shared` for fanout.** When three steps all need the entry input, write it into
  `ctx.shared` in the entry step — don't thread it through every `goto` payload.
- **One-off capability call, no automation to keep?** That's not an agent — use Sapiom's
  remote MCP (`https://api.sapiom.ai/v1/mcp`, direct `sapiom_*` tools, `tool_discover` to
  find the right one) or the SDK instead of scaffolding.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module '@sapiom/agent'` | Deps not installed | `npm install` inside the scaffolded dir |
| Type error: `fail(...)` not assignable | Step missing `canFail: true` | Add `canFail: true` to `defineStep` |
| Type error: `terminate(...)` not assignable | Step missing `terminal: true` | Add `terminal: true` to `defineStep` |
| `goto` target rejected by types | Target not in `next[]` | Add the target name to `next` |
| `check` fails: step missing from graph | `steps` object key doesn't match `name` field | Match the key in `steps: { start }` to `defineStep({ name: "start" })` |
| `run_local` reports `unusedStubs` | Stub path typo or namespace/handle mix-up | Namespace path for calls (`repositories.list`), singular for handles (`repository.pushFromSandbox`) |
| Paused step resumes with empty input | Manual gate; `run_local` auto-resumes with `{}` | Type the resumed step's input with optional fields |
| `sapiom_authenticate` → credential not found at deploy | Authenticated in a different shell | Re-run `sapiom_authenticate`; credential is per-machine in `~/.sapiom/credentials.json` |

## References

| Resource | What it covers |
|---|---|
| [Authoring guide](https://docs.sapiom.ai/agents/authoring) | Full step model, failure patterns, pause/resume, determinism |
| [Quickstart](https://docs.sapiom.ai/agents/quick-start) | Scaffold → write → test → deploy walkthrough |
| [Capabilities](https://docs.sapiom.ai/capabilities) | The full `ctx.sapiom.*` catalog with pricing |
| `AGENTS.md` in your scaffold | The quick in-project reference |
