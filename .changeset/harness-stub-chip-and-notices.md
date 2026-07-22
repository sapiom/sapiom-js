---
"@sapiom/harness": patch
---

Surface how an offline run's stubs behaved in the run inspector. A step that ran in an offline (stub) run now shows a read-only "stubbed" chip on its row and in its detail, so it is clear its capability calls were served by stubs rather than real calls. The inspector also shows, when present, a read-only notice for supplied stubs that matched no capability call (a no-op mock — usually a typo or the wrong path) and for stubs whose value had the wrong shape — so a stub that silently did nothing is visible instead of a mystery. Nothing is shown when a run has no such issues, and the affordance names capabilities, never a model. Real (non-offline) runs are unaffected.
