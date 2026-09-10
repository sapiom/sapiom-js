# Insight report dashboard

The page this template ships beside its agent: the latest report, the flagged
anomaly, the follow-up read as a bar chart, and the delivery facts — every number
on it produced by a run of the agent.

```
node server.mjs          # http://localhost:4173
```

No build step and no dependencies: one Node server (`server.mjs`) serving one
page (`index.html`) and one JSON route (`/api/report`).

## Where the data comes from

| Environment                                         | The page shows                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAPIOM_API_KEY` **and** `SAPIOM_DEFINITION_ID` set | **Live** — the latest completed run of that deployed agent, read over the Sapiom API (`SAPIOM_API_URL` optional, defaults to production) and cached for 30 s. |
| Either missing, or the live read fails              | **Captured** — `sample-report.json`, the verbatim output of a real zero-setup run of this template. Never empty, never invented.                              |

The footer of the page names the source and the run id either way.

When Sapiom publishes this dashboard as an App Link on clone, the publish step
injects the two variables. Running it by hand, export them yourself to point the
page at your own agent.

## Screenshot

`preview.png` (one directory up, referenced by `template.json` → `app.preview`)
is a capture of this page in captured mode. Regenerate it from the repo root
after a visual change: `pnpm examples:app:screenshot scheduled-db-insight-report`.
