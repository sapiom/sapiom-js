# Scene video dashboard

The page this template ships beside its agent: the finished video in a player,
a filmstrip of frames decoded from it, and the shot list the model planned for
it, every frame and every prompt produced by a run of the agent.

```
node server.mjs          # http://localhost:4174
```

No build step and no dependencies: one Node server (`server.mjs`) serving one
page (`index.html`), one JSON route (`/api/run`), and the captured run's media
under `/sample/`.

## Where the data comes from

| Environment                                         | The page shows                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAPIOM_API_KEY` **and** `SAPIOM_DEFINITION_ID` set | **Live** — the latest completed run of that deployed agent, read over the Sapiom API (`SAPIOM_API_URL` optional, defaults to production) and cached for 30 s. The video plays from the run's `downloadUrl`, a public permalink. |
| Either missing, or the live read fails              | **Captured** — `sample-run.json`, the verbatim output of a real zero-setup run of this template, with that run's own render bundled as `sample/clip.mp4` (scaled to 720p) and its first frame as `sample/poster.jpg`.           |

The footer of the page names the source and the run id either way.

When Sapiom publishes this dashboard as an App Link on clone, the publish step
injects the two variables. Running it by hand, export them yourself to point the
page at your own agent.

## Screenshot

`preview.png` (one directory up, referenced by `template.json` → `app.preview`)
is a capture of this page in captured mode. Regenerate it from the repo root
after a visual change: `pnpm examples:app:screenshot scene-to-video`.
