# Content pack dashboard

The page this template ships beside its agent: the quote graphics the run
rendered, the tweet thread with each tweet's length against the 280-character
limit, the LinkedIn post and newsletter behind tabs, and what the run
delivered. Every word and every image is produced by a run of the agent.

```
node server.mjs          # http://localhost:4176
```

No build step and no dependencies: one Node server (`server.mjs`) serving one
page (`index.html`), one JSON route (`/api/run`), and the captured run's
graphics under `/sample/`.

## Where the data comes from

| Environment                                         | The page shows                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SAPIOM_API_KEY` **and** `SAPIOM_DEFINITION_ID` set | **Live**: the latest completed run of that deployed agent, read over the Sapiom API (`SAPIOM_API_URL` optional, defaults to production) and cached for 30 s. The graphics load from the run's `downloadUrl`s, which are public permalinks. |
| Either missing, or the live read fails              | **Captured**: `sample-run.json`, the verbatim output of a real zero-setup run of this template, with that run's two graphics bundled as `sample/quote-1.jpg` and `sample/quote-2.jpg`.                                                     |

The footer of the page names the source and the run id either way.

The run's terminal output carries the copy only as the assembled markdown pack.
A run with no recipients returns it inline (`markdown`). A run that emailed the
pack returns only its public link (`packDownloadUrl`), and the server fetches
it from there. The server splits the pack back into the thread, the LinkedIn
post and the newsletter before handing it to the page.

When Sapiom publishes this dashboard as an App Link on clone, the publish step
injects the two variables. Running it by hand, export them yourself to point the
page at your own agent.

## Screenshot

`preview.png` (one directory up, referenced by `template.json` → `app.preview`)
is a capture of this page in captured mode. Regenerate it from the repo root
after a visual change: `pnpm examples:app:screenshot content-repurposing-pipeline`.
