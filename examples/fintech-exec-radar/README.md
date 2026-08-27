# Fintech Executive Opportunity Radar

Track executive moves, investment events, and functional hiring signals across a useful
built-in fintech watchlist. Every company runs as an independent child. Inside
each child, recall, each signal search, persistence, and each article read have
their own step boundary, so a retry never replays another company or a capability
call that already succeeded.

## What it does

```text
plan ──▶ fanOut ─┬─ child(company) ─┬──▶ reduce ──▶ deliver
                 ├─ child(company) ─┤    (rank)      (optional email)
                 └─ child(company) ─┘

child: recall → exec search → funding search → hiring search → prepare
       → persist → scrape 1 → scrape 2 → scrape 3 → finish

plan ──▶ planned                                      (dry run)
plan ──▶ budgetBlocked                                (call ceiling)
```

1. **plan** resolves the built-in 18-company watchlist (or an override), signals,
   search recency hint, scrape cap, delivery, and retry-aware maximum
   capability-call envelope. The zero-input path runs live. `dryRun: true`
   returns here without a capability call, and an oversized plan stops unspent.
2. **fanOut** launches one real child run per company through a four-worker pool.
   Companies stay isolated, while bounded concurrency avoids sending the memory
   and search services an 18-company burst. Every dispatch is wrapped, so
   dispatch failures and child timeouts become coverage rows and partial coverage
   still reaches a terminal digest. The parent step does not impose a shorter
   deadline that could bypass those per-child catches.
3. **the child graph** recalls up to 50 reported-key records, then searches each
   requested signal in a separate step. Only transient errors retry, at most
   once. A terminal error advances with a structured coverage failure.
4. **prepare and persist** require signal-specific event language, filter
   company-owned and LinkedIn URLs, suppress acknowledged keys, and append the
   bounded search-derived observation before optional page enrichment. Generic
   profiles, stock pages, unrelated social posts, and non-functional job listings
   do not become radar events. Persistence failure is visible but never discards
   sourced findings.
5. **scrape 1/2/3** each read one selected article. A transient error retries only
   that article step. A blocked or exhausted read keeps the search snippet and
   records its URL, attempts, error, and `search_snippet` fallback.
6. **reduce** asks a model through the SDK's structured-output path only to rank
   compact indexes into requested-signal items. Markdown is assembled
   deterministically from the original headlines and URLs, so every reported
   claim links to a supplied source.
7. **deliver** returns the digest as the run output and emails it only when
   `deliverTo` is set. It commits only the keys that survived fan-in as reported,
   after a configured email send succeeds; a failed send leaves them eligible for
   retry. Delivery reuses the account's first existing sender inbox, or creates a
   `Fintech Executive Opportunity Radar` inbox when the account has none. A
   post-send acknowledgement failure is exposed in the run output's
   `dedupeCommitFailures`; it does not rewrite the digest that was already emailed.

## Input

```json
{ "deliverTo": "you@example.com" }
```

The setup form puts optional email delivery first. The company list is already
useful and stays an optional advanced override:

Robinhood, SoFi, Klarna, Block, Tether, Intuit, Affirm, Cloudflare, Chime,
Nvidia, Erebor, Revolut (US), Nubank (US), Coinbase, Stripe, Kraken,
Binance (US), and Marqeta.

Input is deduplicated, and a plan with more than 25 unique companies fails before
fan-out instead of silently dropping coverage. Set `dryRun: true` for a no-spend preview.
`window` adds both a plain-language recency phrase and a concrete `after:` date
to each search. Results with a parseable date in their URL are also rejected when
that date falls outside the requested window; undated sources remain eligible
and are shown without a fabricated date. The three signals are:

- `exec_moves`: named executive arrivals and departures. Multiple reports are
  listed individually rather than claimed to be different people or events.
- `funding`: rounds, strategic investments, acquisitions, and PE activity.
- `hiring`: concrete functional hiring signals, not precise headcount or a claim
  that one job listing constitutes a hiring cluster.

Attach a weekly cron trigger to the deployed agent for a standing radar. The
schedule is deliberately outside the definition so the same template can run
weekly, daily, or on demand.

## Cost and failure boundaries

The agent does not copy mutable dollar prices into its source. Sapiom's signed-in
capability catalog quotes current pricing before a production run. The dry-run
output gives that quote a precise quantity basis: child runs, searches, maximum
scrapes, memory reads/writes, one ranking call, and up to four email API calls
(inbox resolution plus delivery) only when configured.
`maxCapabilityCalls` is the structural hard stop; account spending rules remain
the dollar-denominated enforcement layer. Its default of 500 covers the full
25-company input limit, whose retry-aware maximum is 476 calls.

Article reads enrich the evidence supplied to the ranking model; the final
digest still contains only the source headline and URL. Set
`maxScrapesPerCompany` to `0` to rank from search snippets and avoid article-read
calls. When the cap is smaller than the result set, reads rotate across the
requested signals instead of exhausting the budget on the first signal.

Full search-derived observations are appended before article reads under a
namespace derived from the deployed agent slug. A failed history append is
reported under **Partial coverage**, but does not discard already-sourced
findings. The parent marks source keys reported only at the terminal delivery
step, after successful fan-in and, when configured, successful email delivery.
Dedupe recall filters specifically for those acknowledgement records.
Only five items per company cross that boundary; selection rotates across the
requested signals, and overflow or an interrupted fan-in remains eligible for a
later digest. A run that covers 15 of 18 companies returns a useful 15-company
digest and names the other three with their failure reasons. Signal-level search
failures on otherwise covered companies also appear under **Partial coverage**.

The terminal contract distinguishes `complete`, `partial`, `no_evidence`, and
`no_coverage`. It also returns `unmet[]` plus company, search, scrape, persistence,
ranking, and delivery health. A truthful partial result is a completed Agent run,
not a green-looking claim that every source worked.

## Run it with the Sapiom MCP

1. Install dependencies: `npm install`.
2. Run `npm run typecheck`.
3. Use `sapiom_dev_agents_check`, then `sapiom_dev_agents_run_local`.
4. Authenticate, then link → deploy → run → inspect.
5. Run the zero-input live watchlist twice. The second digest should contain only
   source keys absent from the first run.

Local Run replaces `ctx.sapiom.*` calls with stubs, so it creates no capability
spend. A production run uses real search, scraping, memory, child runs, model
ranking, and optional email delivery.

## Deliberate v1 limits

- No precise headcount claims.
- No LinkedIn or likely company-owned URLs in the digest or article reads.
- No paywall bypassing; the search snippet remains when article reading fails.
- No CRM or spreadsheet write-back.
- No company-list UI beyond the agent's typed JSON input.
