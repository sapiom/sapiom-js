---
"@sapiom/harness": patch
---

Agent Studio: opening or adding a project creates no session. A newly created durable project no longer gets an automatic first session titled "Plan Agents" with a bootstrap prompt typed into it; the project is minted, its agents scan in, and the user's own first session is an ordinary one. Reverses the automatic bootstrap first session from #824 to #826 and #834 (flow-creation.md rev 4 §4.1 step 3, Q5). Sessions that already carry bootstrap metadata still resume as ordinary sessions.
