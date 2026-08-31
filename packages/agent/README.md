# @sapiom/agent

The versioned public contract for authoring Sapiom orchestrations.

A lean, dependency-light package (types + a small protocol runtime) shared by
three consumers:

- **Customer orchestration definitions** — authored against this package's types and
  compiled by the build.
- **The sandbox step-runner** — reads a step's input, builds `ctx`, runs one step.
- **The engine** — uses the directive guards + manifest schema; it never runs
  customer code, only validates the pure-data completion payload.

## Install

```sh
npm install @sapiom/agent
```

## Authoring surface

```ts
import {
  defineAgent,
  defineStep,
  goto,
  terminate,
} from "@sapiom/agent";

const start = defineStep({
  name: "start",
  next: ["finish"],
  async run(input, ctx) {
    return goto("finish", { greeting: `hello ${input.name}` });
  },
});

const finish = defineStep({
  name: "finish",
  next: [],
  terminal: true,
  async run() {
    return terminate({ done: true });
  },
});

export const hello = defineAgent({
  name: "hello",
  entry: "start",
  steps: { start, finish },
});
```

A step declares the transitions it may take (`next` / `terminal` / `canFail` /
`pause`); the `run` return type is derived from those declarations, so an
undeclared transition is a compile error. The build reads those same declarations
to render the orchestration graph without executing anything.

## Package graph evidence

`PackageInventory` answers which agents exist and where they live. The separately
versioned package graph-evidence protocol answers why two inventory agents are
connected. Protocol 1 admits four factual relation/basis pairs:

| Relation  | Basis               | Evidence meaning                           |
| --------- | ------------------- | ------------------------------------------ |
| `invokes` | `static-invocation` | Source proves one agent starts another     |
| `invokes` | `runtime-dispatch`  | The engine observed a caller/callee pair   |
| `feeds`   | `static-dataflow`   | Source provenance reaches another input    |
| `feeds`   | `runtime-handoff`   | Runtime lineage proves a supported handoff |

Every accepted record names `fromAgentKey` and `toAgentKey` explicitly. Static
results reuse the exact inventory version and additionally carry an analysis
fingerprint, producer identity/version, coverage, deterministic diagnostics, and
quarantine. Runtime evidence is an append-only bundle event keyed by an
authoritative event ID. Keep one runtime evidence state per immutable bundle and
start a fresh state when the bundle digest changes; cross-bundle appends conflict
and leave the existing state unchanged. The helpers expose reference
replacement/idempotency semantics only; persistence and production graph
projection remain server concerns.

```ts
import {
  createPackageGraphEvidenceStaticResult,
  type PackageInventory,
} from "@sapiom/agent";

export function directInvocationEvidence(inventory: PackageInventory) {
  return createPackageGraphEvidenceStaticResult(
    {
      scope: inventory.version,
      producer: { id: "acme.direct-invocation", version: "1.0.0" },
      analysisFingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      outcome: "success",
      coverage: { status: "complete" },
      candidates: [
        {
          fromAgentKey: "coordinator",
          toAgentKey: "research",
          relation: "invokes",
          basis: "static-invocation",
          mode: "blocking",
          callsites: [
            { kind: "source-callsite", ref: "callsite:coordinator.research" },
          ],
        },
      ],
    },
    inventory,
  );
}
```

Evidence producers must create opaque handles and keep absolute or relative
paths, execution IDs, lineage IDs, prompts, reports, inputs, outputs, and tool
payloads behind an authorized producer-owned resolver. The schema enforces a
restricted public-safe character set for those handles; it cannot determine
whether a permitted string contains a sensitive identifier. Graph evidence is
explanatory metadata only: it cannot change execution, routing, authorization,
deployment, builds, or billing.

## Package AgentFacts

`PackageInventory` is also the authority for per-agent factual metadata. The
AgentFacts protocol emits one normalized record for every inventory `agentKey`;
extractors must not rediscover, rename, or infer identity. Missing or partial
cards become `unknown` or `partial` fields with diagnostics, not deleted agents.

Supported facts are intentionally narrow: authored descriptions, exact
input/output JSON Schemas, declared capabilities, observed capabilities from
allowlisted structured capability-call observations, direct/source/evidence
references, completeness, diagnostics, and deterministic template summaries.
Unsupported observations are diagnosed and ignored, and semantic prose or
relationships are never inferred from names or paths.

## The entry input contract

A step's `inputSchema` (a zod schema, imported from `zod/v4`) types and validates that
step's input. The **entry step's `inputSchema` is special — it is the agent's public API**:
the dashboard Run form, the trigger snippet, and the engine's pre-dispatch validation are
all derived from it. Declare it on the entry step, with a `.default()` on each field so a
zero-input run still validates:

```ts
import { defineStep, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

const start = defineStep({
  name: "start",
  next: [],
  terminal: true,
  inputSchema: z.object({
    repo: z.string().default("sapiom/sapiom"),
  }),
  // `input` is inferred + validated from inputSchema: { repo: string }
  async run(input) {
    return terminate({ scanned: input.repo });
  },
});
```

`inputSchema` on a non-entry step types that step's inbound payload the same way — including
a **resumed** step's signal payload, shown next.

## Cross-step state and its quota

`ctx.shared` is the typed key/value store for compact state that several later
steps need. Its **entire snapshot** may contain at most **256 KiB (262,144
bytes), inclusive**, measured as the UTF-8 byte length of compact
`JSON.stringify(snapshot)`. Keys, JSON punctuation, existing values, and the
new value all count toward the same limit.

The SDK's `InMemoryContextStore.set()` synchronously measures the complete
candidate snapshot before committing it. An oversized or unserializable
candidate throws and leaves the previous snapshot unchanged. Hosts gain this
setter-time gate when they construct this store version; hosts that have not
adopted it may enforce the contract only at execution boundaries during rollout.

Measurement follows `JSON.stringify` rather than a stricter JSON-value
validator: values JSON normally omits or coerces retain those semantics, while
circular references, BigInt values, and throwing `toJSON` methods are rejected.

Keep small scalars, IDs, and durable-storage references in `ctx.shared`. Put
bulk API responses, documents, research results, and other large state in
durable storage, then carry only the resulting ID or reference. The stable
machine code for an oversized candidate is `CTX_SHARED_SIZE_LIMIT_EXCEEDED`;
JSON encoding failures use `CTX_SHARED_SERIALIZATION_FAILED`. Use the exported
structural guards and structured fields rather than parsing messages or relying
on `instanceof`: the host runner and an authored definition may carry separate
inlined SDK copies.

`TypedContextStore` has no `delete()` operation. To recover from legacy invalid
state, replace an offending key with a compact, JSON-compatible value small
enough to bring the complete candidate within the quota.

## Pausing on a long-running capability

Some `ctx.sapiom` capabilities are **dispatched**: you launch them, they run far
past one step's budget, and they report back when they finish (a coding agent
today; more below). A step can't inline-`await` one — it pauses, and a later step
resumes with the result. `pauseUntilSignal` accepts the launch handle (or the
launch promise itself) and reads everything it needs off it:

```ts
import { defineStep, pauseUntilSignal, terminate } from "@sapiom/agent";
import { CODING_RESULT_SIGNAL } from "@sapiom/tools";

const code = defineStep({
  name: "code",
  next: ["review"],
  // capability's exported signal constant so the decl can't drift from the handle.
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "review" },
  async run(input, ctx) {
    // launch returns immediately; hand it straight to pauseUntilSignal. The run
    // parks at status='paused' and the dispatch loop exits.
    return pauseUntilSignal(
      ctx.sapiom.models.coding.launch({ task: input.task }),
      {
        resumeStep: "review",
      },
    );
  },
});

const review = defineStep({
  name: "review",
  next: [],
  terminal: true,
  // Give this step an `inputSchema` (a zod schema for the capability's result
  // shape) to type + validate what it receives.
  async run(result, ctx) {
    // Fires on success OR failure — branch on the terminal result.
    return terminate({ ok: result.status === "completed" });
  },
});
```

Things to know:

- **The pause is a real suspend across processes**, so the launch and the resume
  are two steps — you can't fold them into one inline `await`.
- **The resumed step receives the capability's result as its input.** Declare its
  `inputSchema` to type + validate it (each capability documents its result shape).
- **Pass the launch promise directly** for the one-liner above, or `await` it first
  when you need the handle — to stash the run id in `ctx.shared`, or to `try/catch`
  a launch failure and route somewhere other than a retry. Awaiting doesn't lose
  the pause; the resolved handle still flows into `pauseUntilSignal`:

  ```ts
  async run(input, ctx) {
    const run = await ctx.sapiom.models.coding.launch({ task: input.task });
    ctx.shared.set("codingRunId", run.runId); // readable from the resumed step
    return pauseUntilSignal(run, { resumeStep: "review" });
  }
  ```

- **Outside an agent run nothing changes** — `await launch().wait()` the capability as
  usual; the pause wiring only engages when a step pauses on the handle.

### Compatible capabilities

Any capability whose `launch` returns a `DispatchHandle` (a `dispatch` member) is
pausable; each ships a stable result-signal constant for the `pause` decl. This
list grows as capabilities land:

| Capability   | Launch                              | Pause signal                             |
| ------------ | ----------------------------------- | ---------------------------------------- |
| Coding agent | `ctx.sapiom.models.coding.launch(…)` | `CODING_RESULT_SIGNAL` (`@sapiom/tools`) |
