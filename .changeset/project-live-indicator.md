---
"@sapiom/harness": minor
"@sapiom/harness-desktop": patch
---

A project row in the rail now shows a green dot when the project has live coding-agent sessions, so which projects are active reads at a glance without opening them. The dot names its own count, "1 live session" or "3 live sessions", in its tooltip and to a screen reader, and it disappears when the last of those sessions ends. Group headers carry the same dot for the agents filed under them. Project and group counts use the same durable project identity as the session tabs, keeping nested projects separate and including a project's sessions across roots. Older servers without Studio project identities retain folder-based membership. Agent rows are unchanged, and the rail still lists no sessions.
