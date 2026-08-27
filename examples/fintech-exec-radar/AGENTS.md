# Working in this agent

This project defines exactly one Sapiom agent in `index.ts`: **Fintech Exec
Radar**. It tracks executive moves, funding, and hiring across a bounded company
list, persists each company's observations immediately, suppresses source URLs
that the parent previously acknowledged as reported, and returns a sourced
markdown digest.

## The two roles

- `mode: "coordinate"` (default) resolves the plan, dispatches one child run per
  company with `ctx.sapiom.agents.run`, reduces the slim child summaries, and
  optionally emails the digest.
- `mode: "research"` is the bounded child. It handles exactly one `company` and
  never calls `agents.run`, so recursion stops at one level.

The default `childDefinition` is `ctx.agentName`, so one deployed copy composes
itself with no second deployment. A caller can point `childDefinition` at a
compatible dedicated research-agent slug.

## Invariants to preserve

- Never put article bodies or cumulative company results in `ctx.shared`.
- Keep `MAX_COMPANIES`, per-signal result limits, scrape limits, evidence length,
  and child-summary length bounded.
- Every child dispatch must remain wrapped; a failed child is a coverage row,
  never a failed batch. Do not add a `fanOut` step deadline shorter than the
  child wait performed by `agents.run`, because the engine deadline would bypass
  the per-child catch and discard completed coverage.
- Attempt to append full company observations as best-effort history before the
  child terminates; a failed history write must not discard sourced findings.
  The parent receives only the bounded `summaryItems` array and must acknowledge
  their keys as reported only in the terminal delivery step after fan-in and,
  when email is configured, after the send succeeds. A delivery failure must
  leave keys eligible for retry. Keep history and acknowledgement records
  separated by metadata filters.
- Every digest item must use a URL supplied by search. The model may rank existing
  requested-signal items by compact index through `llm.run` structured output,
  but it must never author claims or source URLs.
- `dryRun` and `budgetBlocked` must branch before any capability call.

## Test it

Run `npm run typecheck`, then use the Sapiom developer MCP:

1. `sapiom_dev_agents_check`
2. `sapiom_dev_agents_run_local` with `{ "dryRun": true }`
3. `sapiom_dev_agents_run_local` with a 15-company coordinator input and explicit
   `agents.run` / `llm.run` stubs
4. `sapiom_dev_agents_run_local` with `mode: "research"` and explicit search,
   scrape, memory-recall, and memory-append stubs

Require `unusedStubs` and `stubWarnings` to both be empty. A production E2E is
link → deploy → run with all 15 companies → inspect to terminal. Run it twice to
prove the second run suppresses the first run's source keys.
