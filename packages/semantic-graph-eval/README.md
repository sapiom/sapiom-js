# Semantic graph evaluation

This private workspace package is the SAP-3002 evaluation harness for semantic-only package graph relationships. It is deliberately unpublished and has no production consumer.

The full path is:

```text
immutable synthetic fixture
  → normalized whole-project packet
  → one raw provider attempt
  → deterministic structural validation
  → accepted/rejected experimental snapshot
  → hidden-oracle scoring
  → sanitized normalized report
```

The harness consumes only public Protocol-1 inventory and Phase A evidence APIs from `@sapiom/agent`. An accepted candidate is structurally legal and traceable; only the separately loaded oracle can determine whether it is semantically correct.

## Safety boundary

- Synthetic fixtures only; no customer code, prompts, outputs, payloads, credentials, or environment values.
- No production persistence, scheduling, deployment, API, UI, or render integration.
- No extension of `PackageGraphEvidence` and no semantic evidence basis.
- Real evaluation pins the Sapiom routing label `gpt-luna` with `neverFail: false`.
- Exactly one global call per fixture/configuration identity; no retries, repair calls, or per-agent calls.
- CI and `eval:mock` make no network calls.
- Oracles never enter packet, prompt, provider, snapshot, or normalized-report inputs.

## Corpus and configurations

`fixtures/v1` contains 18 byte-locked cases: 10 calibration and 8 holdout. Every case has separate `input.json`, `oracle.json`, and raw `provider-response.json` files. `fixtures:generate` must reproduce the committed corpus byte-for-byte; changing a recorded v1 case requires a new fixture protocol rather than an in-place edit.

The committed configuration identities are:

- `facts-only.v1` — no source excerpts.
- `bounded-source.v1` — at most 2,500 allowlisted source characters; calibration baseline.
- `context-pressure.v1` — at most 18,000 source characters for pressure diagnostics.
- `bounded-source.v2` — the stricter precision policy frozen for holdout.

See [DECISION.md](./DECISION.md) for the measured Luna results and rollout recommendation.

## Commands

```bash
pnpm --filter @sapiom/semantic-graph-eval fixtures:generate
pnpm --filter @sapiom/semantic-graph-eval test
pnpm --filter @sapiom/semantic-graph-eval typecheck
pnpm --filter @sapiom/semantic-graph-eval lint
pnpm --filter @sapiom/semantic-graph-eval build
pnpm --filter @sapiom/semantic-graph-eval eval:mock
```

`eval:mock` traverses the real packet, prompt, parser, validator, scorer, and reporter over all 72 fixture/configuration identities. It checks the committed aggregate fingerprint and writes a byte-stable report beneath `.temp/semantic-graph-eval/mock/`.

Real Luna runs are opt-in:

```bash
RUN_REAL_SEMANTIC_GRAPH_EVAL=1 SAPIOM_API_KEY=... \
  pnpm --filter @sapiom/semantic-graph-eval eval:luna -- \
  --configuration bounded-source.v2 --set calibration
```

Both `RUN_REAL_SEMANTIC_GRAPH_EVAL=1` and `SAPIOM_API_KEY` are mandatory. Luna mode requires an explicit `--configuration` and either `--set calibration` or `--set holdout`; holdout refuses every configuration except the frozen one. Normalized reports are written below `.temp/semantic-graph-eval/` and remain uncommitted. They contain candidate evidence, input/configuration/packet/prompt/normalized-output fingerprints, and supported metadata, but never credentials, raw request headers, raw provider bodies, or unrestricted source.

Gateway invocation failures, malformed model output, and post-response harness normalization faults remain distinct. Harness faults use a fixed sanitized rejection code, allowing the CLI to write the partial paid-run evidence before it exits nonzero without misreporting the fault as a provider failure.
