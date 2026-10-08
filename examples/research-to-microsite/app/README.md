# Report site dashboard

The page this template ships beside its agent: the site the run published, in a
frame, with the self-critique verdicts that let it through (the rationale that
sent a draft back, and the one the published draft cleared the bar with), the
sources it read and cited, and whether the live URL still answers.

```
node server.mjs          # http://localhost:4179
```

No build step and no dependencies: one Node server (`server.mjs`) serving one
page (`index.html`), one JSON route (`/api/run`), and the captured run's built
site at `/sample/site.html`.

This page is not the site the agent publishes. That site is generated at run
time by a coding agent into its own git repo, so there is no source for it in
this template, and its preview host is recycled unless an uptime keeper was
registered. This page is the view of the run around it.

## Where the data comes from

| Environment                                         | The page shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAPIOM_API_KEY` **and** `SAPIOM_DEFINITION_ID` set | **Live** — the latest completed run of that deployed agent, read over the Sapiom API (`SAPIOM_API_URL` optional, defaults to production) and cached for 30 s. The frame shows the run's `liveUrl` when its `/health` answers; otherwise the report's outline.                                                                                                                                                                                                                                |
| Either missing, or the live read fails              | **Captured** — `sample-run.json`, a real zero-setup run of this template (agent run 160003): its terminal output verbatim, plus the self-critique fields from its shared state and the report's summary and section headings (the full report is on the built site). The frame shows the page that run built, copied verbatim from its git repo `microsite-160003` into `sample/site.json` (repo, commit, HTML) and served at `/sample/site.html`. Its preview host has since been recycled. |

The footer of the page names the source and the run id either way.

When Sapiom publishes this dashboard as an App Link on clone, the publish step
injects the two variables. Running it by hand, export them yourself to point the
page at your own agent.

## Screenshot

`preview.png` (one directory up, referenced by `template.json` → `app.preview`)
is a capture of this page in captured mode. Regenerate it from the repo root
after a visual change: `pnpm examples:app:screenshot research-to-microsite`.
