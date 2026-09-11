---
"@sapiom/harness": patch
---

Hide internal Assistant completion markers with an incorrect turn ID in streamed responses and saved history. Preserve literal prose and invalid marker syntax, and restore incomplete marker candidates when streaming ends. Completion still requires the expected turn ID; an unconfirmed answer remains Stopped.

Keep the Assistant conversation and unsent draft visible while automatic answer recovery reconnects the event stream and reconciles saved history and execution status.
