---
"@sapiom/harness": patch
---

Add `POST /api/runs/local`: run an agent entirely offline against stub capabilities and stream the result back as NDJSON — one per-step trace line, then a terminal summary carrying the run outcome plus which supplied stub keys went unused or had the wrong shape. It runs in a child process, needs no sign-in, and makes no network call, so a local run works signed-out and at zero cost.
