---
"@sapiom/harness": minor
"@sapiom/harness-desktop": patch
---

A project row in the rail now shows a green dot when one or more of its agents has a running session, so which projects are active reads at a glance without opening them. The dot names its own count, "1 live session" or "3 live sessions", in its tooltip and to a screen reader, and it disappears when the last of those sessions ends. Group headers carry the same dot for the agents filed under them. Agent rows are unchanged, and the rail still lists no sessions.
