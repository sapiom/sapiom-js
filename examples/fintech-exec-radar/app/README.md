# Opportunity radar dashboard

The page this template ships beside its agent: the new sourced items grouped by
signal, each company's result with its new and found item counts, the run-health
counters, and the steps that degraded. Every headline and every count on it
comes from a run of the agent.

```
node server.mjs          # http://localhost:4185
```

No build step and no dependencies: one Node server (`server.mjs`) serving one
page (`index.html`) and one JSON route (`/api/run`).

## Where the data comes from

| Environment                                         | The page shows                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAPIOM_API_KEY` **and** `SAPIOM_DEFINITION_ID` set | **Live** — the latest completed radar run of that deployed agent, read over the Sapiom API (`SAPIOM_API_URL` optional, defaults to production) and cached for 30 s. The per-company research runs share the definition and are skipped; so are dry-run previews, which have no digest. |
| Either missing, or the live read fails              | **Captured** — `sample-run.json`, the terminal output of a real run of this template on its built-in 18-company watchlist.                                                                                                                                                             |

The footer of the page names the source and the run id either way.

The captured run (agent run 379307) set `deliverTo`, so it emailed its digest.
The recipient address is redacted in `sample-run.json`; nothing else is changed.
A zero-setup run differs only in delivery: it returns the same digest inline.
That run's ranking pass fell back to source order, which the page says above
the item list; the ranking call's token cap has since been raised.

When Sapiom publishes this dashboard as an App Link on clone, the publish step
injects the two variables. Running it by hand, export them yourself to point the
page at your own agent.

## Screenshot

`preview.png` (one directory up, referenced by `template.json` → `app.preview`)
is a capture of this page in captured mode. Regenerate it from the repo root
after a visual change: `pnpm examples:app:screenshot fintech-exec-radar`.
