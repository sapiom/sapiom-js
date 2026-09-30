# Draft grading dashboard

The page this template ships beside its agent: the draft the run published,
the judge's score against the pass bar with its one-line rationale, how many
attempts it took, and the brief and rubric the draft was graded on, all taken
from a run of the agent.

```
node server.mjs          # http://localhost:4178
```

No build step and no dependencies: one Node server (`server.mjs`) serving one
page (`index.html`) and one JSON route (`/api/run`).

## Where the data comes from

| Environment                                         | The page shows                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAPIOM_API_KEY` **and** `SAPIOM_DEFINITION_ID` set | **Live**: the latest completed run of that deployed agent, read over the Sapiom API (`SAPIOM_API_URL` optional, defaults to production) and cached for 30 s.                |
| Either missing, or the live read fails              | **Captured**: `sample-run.json`, the verbatim output of a real zero-setup run of this template (input `{}`), which drafted and graded the built-in sample brief and rubric. |

The footer of the page names the source and the run id either way.

The run's output does not repeat its brief and rubric, so the page reads them
from the run's input. A run given no `brief` or `rubric` used the agent's
built-in sample, which `server.mjs` mirrors from `../index.ts`; keep the two in
step if you change the sample there.

When Sapiom publishes this dashboard as an App Link on clone, the publish step
injects the two variables. Running it by hand, export them yourself to point the
page at your own agent.

## Screenshot

`preview.png` (one directory up, referenced by `template.json` → `app.preview`)
is a capture of this page in captured mode. Regenerate it from the repo root
after a visual change: `pnpm examples:app:screenshot eval-gate`.
