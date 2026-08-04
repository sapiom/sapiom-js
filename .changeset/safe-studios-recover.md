---
"@sapiom/analytics-core": patch
"@sapiom/harness": patch
---

Keep isolated Agent Studio launches out of normal consent and analytics state,
make browser launch and session-history sources failure-tolerant, preserve agent
binding across portable continuation, retry transient run inspection, and drop
analytics events whose privacy redaction cannot complete.
