# Working in this agent

This project defines exactly one Sapiom agent in `index.ts`: **Fintech Executive
Opportunity Radar**. It tracks executive moves, funding, and hiring across a
built-in 18-company watchlist, persists each company's observations immediately,
suppresses source URLs that the parent previously acknowledged as reported, and
returns a sourced markdown digest.

## The two roles

- `mode: "coordinate"` (default) resolves the plan, dispatches one child run per
  company with `ctx.sapiom.agents.run`, reduces the slim child summaries, and
  optionally emails the digest.
- `mode: "research"` is the bounded child. It handles exactly one `company` and
  never calls `agents.run`, so recursion stops at one level. Its graph isolates
  recall, each signal search, persistence, and each of three article reads.

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
  the per-child catch and discard completed coverage. Keep the company worker
  pool bounded so isolation does not become an upstream capability burst.
- Retry only an individual capability-bearing child step and only for a
  classified transient error. Keep the two-attempt ceiling. Never add retry to
  `fanOut`, `reduce`, or `deliver`: that would replay completed children, ranking,
  persistence, or delivery. Health denominators count logical operations; track
  extra capability attempts separately in `retries`.
- Attempt to append full company observations as best-effort history before the
  optional scrape steps; a failed history write must not discard sourced
  findings. A scrape failure must retain the search snippet and surface a
  structured `coverageFailures` row with the URL and fallback.
  The parent receives only the bounded `summaryItems` array and must acknowledge
  their keys as reported only in the terminal delivery step after fan-in and,
  when email is configured, after the send succeeds. A delivery failure must
  leave keys eligible for retry. Keep history and acknowledgement records
  separated by metadata filters.
- Every digest item must use a URL supplied by search. The model may rank existing
  requested-signal items by compact index through `llm.run` structured output,
  but it must never author claims or source URLs.
- `dryRun` and `budgetBlocked` must branch before any capability call. A
  zero-input run is intentionally live and uses the retry-aware call ceiling.
- Review the defaults as a coherent set for re-identification risk. Publish only
  organization-level market inputs explicitly approved for the template; never add
  personal identifiers or contact details.

## Test it

Run `npm run typecheck`, then use the Sapiom developer MCP:

1. `sapiom_dev_agents_check`
2. `sapiom_dev_agents_run_local` with `{ "dryRun": true }`
3. `sapiom_dev_agents_run_local` with the default coordinator input and explicit
   `agents.run` / `llm.run` stubs
4. `sapiom_dev_agents_run_local` with `mode: "research"` and explicit per-step
   search, scrape, memory-recall, and memory-append stubs

Require `unusedStubs` and `stubWarnings` to both be empty. A production E2E is
link → deploy → run with all default companies → inspect to terminal. Run it
twice to prove the second run suppresses the first run's source keys.
