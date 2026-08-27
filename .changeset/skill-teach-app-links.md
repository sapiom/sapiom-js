---
"@sapiom/agent-core": patch
---

`sapiom-sandbox-preview` skill now teaches App Links. It says plainly that a
sandbox preview URL is temporary (it dies with the resource's `ttl`, along with
any bookmark or Slack message it was pasted into), and adds a "Make it durable /
share it" section that routes "share this", "send this to my team", "a permanent
link", "keep it alive", "my link died" to `sapiom_dev_app_publish` — with the
five facts an agent otherwise gets wrong: wake-on-demand cold start, org-scoped
by default (public needs `confirmPublic` + `dailySpendCapUsd`, so ask first),
republish-in-place on the same slug, text-only bundles, and the ~10 MiB cap. The
frontmatter `description` picks up the durability triggers so the skill fires on
a "link that won't die" ask.
