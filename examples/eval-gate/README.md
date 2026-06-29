# eval-gate

Score an output against **your** rubric, then gate the next step on the score —
authored as a **deployable Sapiom orchestration**. One artifact (`index.ts`) that
runs **three different ways with no code changes**.

The eval-gate is **not a capability**. Decomposed, it is a reference template
built entirely from primitives you already have:

| Piece                  | What it is                                             | Primitive                      |
| ---------------------- | ------------------------------------------------------ | ------------------------------ |
| Score an output        | one LLM call with a judge prompt → a number            | the LLM gateway (`judge.ts`)   |
| Branch on the score    | `score >= threshold ? publish : revise`                | engine control flow            |
| Build the judge prompt | string templating from **your** rubric + a score parse | `judge.ts` (the only new code) |

We own the harness (a default judge prompt + a score parser) and the pattern.
**The rubric is yours** — we ship one generic default judge prompt you override,
never an opinion about what "quality" means.

## The step graph

```
judge ─▶ gate ─┬─▶ publish   (score >= threshold)
               └─▶ revise    (score <  threshold)
```

| Step                 | What it does                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `judge` (entry)      | Build the judge prompt from **your** rubric, call the LLM gateway, parse the score from the reply.                                |
| `gate`               | Pure branch: `score >= threshold` ⇒ `publish`, else `revise`. No capability call — a copy can drive both sides deterministically. |
| `publish` (terminal) | The output passed; terminate with `{ decision: "publish", score, … }`. **You** decide what "publish" means.                       |
| `revise` (terminal)  | The output failed; terminate with `{ decision: "revise", score, … }`.                                                             |

Shape: `(input, output, rubric, threshold) → { decision, score }`. Copy this as a
starter, or call it by slug via `orchestrations.launch` from a parent workflow
that produced `output` and branch on the returned decision.

> **Why the judge is a raw gateway call (and not `ctx.sapiom.llm.*`):** there is
> no `llm` capability YET. `judge.ts` reads `LLM_GATEWAY_*` directly (injected
> like `SAPIOM_API_KEY`). When the `llm` capability lands, `callJudge` swaps for
> `ctx.sapiom.llm.*` with **no other change** — and because the judge is an
> ordinary gateway call, the engine's routing/capacity layer sits in front of it
> for free. No evals-specific execution path is created.

## RUN MODE 1 — offline (free, works today)

`runLocal` plays the engine. The eval-gate makes **no `ctx.sapiom.*` capability
call** (the judge is a raw gateway call), so there is nothing for `runLocal`'s
capability stub to intercept — instead the harness **fakes the gateway HTTP** by
monkeypatching `globalThis.fetch` with a canned judge reply. Same step bodies, no
network, no credentials.

```bash
cd examples/eval-gate
npm install
npm start
```

You'll see the per-step trace ending in a `publish` terminal output:

```
=== OFFLINE MODE — scenario: publish (high score) (faked judge score 0.9, threshold 0.7) ===

workflow "eval-gate" → completed

▶ judge (succeeded)
    · judge: scored output against rubric {"score":0.9,"threshold":0.7}
▶ gate (succeeded)
    · gate: score met threshold → publish {"score":0.9,"threshold":0.7}
▶ publish (succeeded)
    · publish: output passed the eval-gate {"score":0.9}

final output: { "decision": "publish", "score": 0.9, "threshold": 0.7, "rationale": "offline stub: canned judge reply" }
```

**See the other branch** — a faked low score makes `gate` take `revise`:

```bash
DEMO_SCENARIO=revise npm start
```

Override the case being judged:

```bash
npm start -- --rubric "Must cite a source" --output "The sky is blue." --threshold 0.8
```

## RUN MODE 2 — live (real Sapiom LLM gateway; the judge call is real + metered)

Point the harness at your LLM gateway and run with `--mode live`:

```bash
LLM_GATEWAY_BASE_URL=https://<your-gateway> \
LLM_GATEWAY_API_KEY=<your-key> \
LLM_GATEWAY_MODEL=claude-sonnet-4-6 \
npm run start:live
```

- `LLM_GATEWAY_BASE_URL` — the gateway origin; the judge POSTs `…/v1/messages`.
- `LLM_GATEWAY_API_KEY` — a key the gateway accepts (`Authorization: Bearer …`).
- `LLM_GATEWAY_MODEL` — optional judge model alias (default: `claude-sonnet-4-6`).

Same step bodies as offline — only the gateway is real instead of faked.

## RUN MODE 3 — Sapiom execution (Blaxel sandbox)

The **same** `index.ts` is the deployed artifact — no code changes between modes.
The control plane is the `@sapiom/cli`:

```bash
sapiom orchestrations link eval-gate --create
sapiom orchestrations deploy
sapiom orchestrations run \
  --input '{"input":"Write a tagline for a privacy-first email app.","output":"Inbox peace, finally.","rubric":"Concise, mentions privacy.","threshold":0.7}'
```

## How it maps onto production

In all three modes the engine/harness swaps _underneath_ the step bodies, never
the bodies themselves:

- **offline:** `runLocal` is the engine; a faked `fetch` is the gateway.
- **live:** `runLocal` is the engine; your real LLM gateway serves the judge call.
- **Sapiom execution:** the real engine bundles `index.ts`, mints a per-run scoped
  key, and walks the steps in a Blaxel sandbox — the judge call routes through the
  gateway like any other.
