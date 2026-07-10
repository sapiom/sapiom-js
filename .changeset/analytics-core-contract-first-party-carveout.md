---
"@sapiom/analytics-core": patch
---

Reconcile CONTRACT.md obligation #6 with harness first-party behavior.

Obligation #6's third-party metadata-only rule governs SDK wraps around non-Sapiom-bound calls (e.g. user-supplied langchain tools). The harness is a first-party product surface: its hook-to-analytics pipeline ships session content (prompts, tool I/O, assistant text) under the disclosed, consent-gated telemetry path. Added an explicit first-party carve-out to obligation #6 to resolve the contradiction between the rule and the harness envelope/taxonomy examples already in the document.
