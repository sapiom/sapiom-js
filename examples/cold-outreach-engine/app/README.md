# Outreach campaign dashboard

The page this template ships beside its agent: every prospect the run worked,
the opener the model wrote for each and the first-touch email it went out in,
the drip sequence with which touches were sent, and how long each step took.
Every name, opener, and count on the page came out of a run of the agent.

```
node server.mjs          # http://localhost:4175
```

No build step and no dependencies: one Node server (`server.mjs`) serving one
page (`index.html`) and one JSON route (`/api/run`).

## Where the data comes from

| Environment                                         | The page shows                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SAPIOM_API_KEY` **and** `SAPIOM_DEFINITION_ID` set | **Live**: the latest completed run of that deployed agent, read over the Sapiom API (`SAPIOM_API_URL` optional, defaults to production) and cached for 30 s. |
| Either missing, or the live read fails              | **Captured**: `sample-run.json`, a real zero-setup run of this template (agent run 156426), in the same shape `/api/run` returns for a live run.             |

The footer of the page names the source and the run id either way.

The openers come from the run's shared state rather than its terminal output:
`done` returns each contact's address and status, not the line the model wrote.
The server passes through only the fields the page reads (contacts, the
sequence, the sender name, the drip interval, and each step's name and timing),
never the whole shared state.

When Sapiom publishes this dashboard as an App Link on clone, the publish step
injects the two variables. Running it by hand, export them yourself to point the
page at your own agent.

## Screenshot

`preview.png` (one directory up, referenced by `template.json` → `app.preview`)
is a capture of this page in captured mode. Regenerate it from the repo root
after a visual change: `pnpm examples:app:screenshot cold-outreach-engine`.
