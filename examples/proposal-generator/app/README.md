# Quote review dashboard

The page this template ships beside its agent: the proposal a run drafted (its
title, summary, priced line items and totals), where it got to at the sign-off
gate, a link to its PDF, and the request it quoted, all taken from a run of the
agent.

```
node server.mjs          # http://localhost:4182
```

No build step and no dependencies: one Node server (`server.mjs`) serving one
page (`index.html`), one JSON route (`/api/run`), and the captured run's PDF at
`/sample/Q-158193.pdf`.

## Where the data comes from

| Environment                                         | The page shows                                                                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAPIOM_API_KEY` **and** `SAPIOM_DEFINITION_ID` set | **Live**: the latest completed run of that deployed agent, read over the Sapiom API (`SAPIOM_API_URL` optional, defaults to production) and cached for 30 s. The PDF opens from the run's `downloadUrl`, a public permalink. |
| Either missing, or the live read fails              | **Captured**: `sample-run.json`, a real zero-setup run of this template (input `{}`), which drafted the built-in sample brief, rendered it, and stopped at the sign-off gate with no approver set.                           |

The footer of the page names the source and the run id either way.

The run's terminal output carries only the headline (title, total, quote
number, PDF link), so the line items, totals, scope, terms and request are read
from the run's shared state, where the `draft` step left them. The execution
read returns both, so there is no second call and nothing mirrored from
`../index.ts`.

`sample-run.json` is that run's output and shared state as the API returned
them, except `downloadUrl`: it was a 15-minute presigned storage link, long
expired, so it is blanked. `sample/Q-158193.pdf` is the same proposal rendered
again from the captured shared state with this template's own `RENDER_SCRIPT`.

When Sapiom publishes this dashboard as an App Link on clone, the publish step
injects the two variables. Running it by hand, export them yourself to point the
page at your own agent.

## Screenshot

`preview.png` (one directory up, referenced by `template.json` → `app.preview`)
is a capture of this page in captured mode. Regenerate it from the repo root
after a visual change: `pnpm examples:app:screenshot proposal-generator`.
