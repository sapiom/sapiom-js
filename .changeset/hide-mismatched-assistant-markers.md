---
"@sapiom/harness": patch
---

Hide internal Assistant completion markers with an incorrect turn ID in streamed responses and saved history. Preserve literal prose and invalid marker syntax, and restore incomplete marker candidates when streaming ends. Completion still requires the expected turn ID; an unconfirmed answer remains Stopped.
