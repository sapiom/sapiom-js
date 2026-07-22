---
"@sapiom/harness": patch
---

Wire prod and offline run logs into the Studio's click-into-step run inspector.

- **Prod runs** light up per-step in the inspector as they progress — status, latency, pass/fail, and (when the run carries them) the step's real input and output. The inspector polls the run's state after it starts and stops quietly once the run finishes or can't be found, so a click into any step shows what it actually did.
- **Offline stub runs** render in the SAME inspector: their streamed per-step trace is mapped into the identical step view (logs, pass/fail, and the input/output each step ran on), so an offline run reads exactly like a real one — just free and untimed, since a stub run records no cost or duration.

Both paths share one step-render shape, so the inspector can never disagree with itself about how a run looks. The inspector names the capability a step called, never a model.
