---
"@sapiom/harness": patch
---

Degrade gracefully when the Studio is offline or the session drops. Losing your network connection no longer blanks the Studio: a boot failure now shows an honest, recoverable state (offline / session needs a refresh / server unreachable) with a Retry that reconnects in place, and a non-blocking banner appears if the connection drops mid-session so the app stays usable against its last-known state. A rejected credential surfaces as a recoverable "reconnect" state rather than a hard lockout. These states are wired to real signals (the browser's connectivity and the kind of the failed request).
