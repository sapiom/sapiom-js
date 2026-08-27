# Fintech Exec Radar

Track executive moves, investment events, and hiring clusters across a named
fintech watchlist. Every company runs as an independent child, so one blocked
source or failed company becomes an honest coverage gap instead of sinking the
whole briefing.

## What it does

```text
plan ──▶ fanOut ─┬─ research(company) ─┬──▶ reduce ──▶ deliver
                 ├─ research(company) ─┤    (rank)      (optional email)
                 └─ research(company) ─┘
                    search → scrape → memory

plan ──▶ planned                                      (dry run)
plan ──▶ budgetBlocked                                (call ceiling)
```

1. **plan** resolves the companies, signals, search recency hint, scrape cap,
   delivery, and exact maximum capability-call envelope. `dryRun: true` returns
   here without a capability call. A plan over `maxCapabilityCalls` also stops
   here, unspent.
2. **fanOut** launches one real child run per company in parallel. Every dispatch
   is wrapped, so dispatch failures and child timeouts become coverage rows and
   partial coverage still reaches a terminal digest. The parent step does not
   impose a shorter deadline that could bypass those per-child catches.
3. **research** searches trade press and other third-party sources for one
   company. A generic registrable-domain check avoids the company's likely own
   site, including subdomains and common country suffixes; it only reads article
   URLs returned by search. Each scrape degrades to the search snippet.
4. **research** recalls up to 50 reported-key records from a namespace isolated
   to that company, using a record-type metadata filter so observation history
   cannot crowd out dedupe acknowledgements. It suppresses those source keys and
   attempts a best-effort append of the full current observation before returning
   five slim items.
5. **reduce** asks a model through the SDK's structured-output path only to rank
   compact indexes into requested-signal items. Markdown is assembled
   deterministically from the original headlines and URLs, so every reported
   claim links to a supplied source.
6. **deliver** returns the digest as the run output and emails it only when
   `deliverTo` is set. It commits only the keys that survived fan-in as reported,
   after a configured email send succeeds; a failed send leaves them eligible for
   retry. Delivery reuses the account's first existing sender inbox, or creates a
   `Fintech Exec Radar` inbox when the account has none. A post-send acknowledgement
   failure is exposed in the run output's `dedupeCommitFailures`; it does not rewrite
   the digest that was already emailed.

## Input

```json
{
  "deliverTo": "you@example.com",
  "companies": ["Example Bank", "Sample Payments", "Demo Capital"],
  "signals": ["exec_moves", "funding", "hiring"],
  "window": "7d",
  "maxScrapesPerCompany": 3,
  "maxCapabilityCalls": 160,
  "dryRun": true
}
```

The run form puts optional email delivery first, requires the companies you
actually track, and keeps tuning controls under optional fields. The first run
previews without spending; set `dryRun: false` only after reviewing its call
envelope. Input is deduplicated, and a plan with more than 15 unique companies
fails before fan-out instead of silently dropping coverage. `window` adds a
recency phrase to each search query; it is a provider hint, not an enforced date
filter, so older results can still appear. The three signals are:

- `exec_moves`: named executive arrivals and departures; two or more newly
  sourced departures from one company in the same run are called out as a
  possible cluster.
- `funding`: rounds, strategic investments, acquisitions, and PE activity.
- `hiring`: directional hiring concentration by function, not precise headcount.

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
the dollar-denominated enforcement layer.

Article reads enrich the evidence supplied to the ranking model; the final
digest still contains only the source headline and URL. Set
`maxScrapesPerCompany` to `0` to rank from search snippets and avoid article-read
calls. When the cap is smaller than the result set, reads rotate across the
requested signals instead of exhausting the budget on the first signal.

Full observations are appended as best-effort history under a namespace derived
from the deployed agent slug. A failed history append is reported under
**Partial coverage**, but does not discard already-sourced findings. The parent
marks source keys reported only at the terminal delivery step, after successful
fan-in and, when configured, successful email delivery. Dedupe recall filters
specifically for those acknowledgement records.
Only five items per company cross that boundary; selection rotates across the
requested signals, and overflow or an interrupted fan-in remains eligible for a
later digest. A run that covers 12 of 15 companies returns a useful 12-company
digest and names the other three with their failure reasons. Signal-level search
failures on otherwise covered companies also appear under **Partial coverage**.

## Run it with the Sapiom MCP

1. Install dependencies: `npm install`.
2. Run `npm run typecheck`.
3. Use `sapiom_dev_agents_check`, then `sapiom_dev_agents_run_local`.
4. Authenticate, then link → deploy → run → inspect.
5. Run the same live input twice. The second digest should contain only source
   keys absent from the first run.

Local Run replaces `ctx.sapiom.*` calls with stubs, so it creates no capability
spend. A production run uses real search, scraping, memory, child runs, model
ranking, and optional email delivery.

## Deliberate v1 limits

- No precise headcount claims.
- No LinkedIn or likely company-owned URLs in the digest or article reads.
- No paywall bypassing; the search snippet remains when article reading fails.
- No CRM or spreadsheet write-back.
- No company-list UI beyond the agent's typed JSON input.
