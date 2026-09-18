---
"@sapiom/tools": minor
---

`browserAutomation`: document `BrowserSession.liveViewUrl` and add `liveViewMode`.

- `liveViewUrl` is an interactive live view of the session's browser that opens on any device.
  It is meant for handing a step the agent should not do itself — a sign-in, a one-time code, a
  payment confirmation — to a person, who acts inside the same session so the agent resumes over
  `cdpUrl` with cookies intact. The link works for as long as the session does and anyone holding
  it can act in the browser, so treat it like a credential. Absent from Local Run stub sessions.
- `BrowserSession.liveViewMode` reports the lifetime of that link; `"persistent"` means it works
  for as long as the session does.
