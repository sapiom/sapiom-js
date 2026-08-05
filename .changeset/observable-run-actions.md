---
"@sapiom/harness": minor
---

Make Test / Run / Deploy observable in Studio: clicking one now reveals the
right pane and switches it to the Steps view (the unified activity surface),
instead of the action landing silently.

- **See it move.** A run's steps advance pending → running → passed in view; the
  acting button carries a `data-running` pulse tied to the real run status (not
  just the brief hand-off ring); and the demo prod run now progresses across
  polls on a wall clock rather than snapping to "completed".
- **Relevant final data up front.** A run-summary card headlines the Steps
  surface — outcome, live progress, total duration, and the single most relevant
  result CTA (the deployed agent's dashboard link → a dev-server preview →
  URLs the run produced → the final step's output). Honest-absence throughout:
  no cost fields, no latency on a still-running step, no fabricated values.
- **Better payload CTAs.** Input / Output / Logs / Result share one disclosure
  with a Copy button (the final Result renders expanded); nothing renders for a
  payload a step never carried.
- **Deploy as an action, not a toast.** Deploy lands in the same Steps surface
  with a live linking → building → deployed banner, then a completion state that
  links to the dashboard and jumps to the "Trigger from your code" snippet.

Note: after an action, the persisted right-pane tab is Steps.
