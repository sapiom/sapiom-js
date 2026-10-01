---
"@sapiom/harness": minor
---

The session bar's running-app slot shows the agent's durable App Link beside the
localhost Preview chip (SAP-3255). When the agent's cloud definition has a
published App Link, an `App Link` chip opens it. The chip shows with or without a
detected port, because the link belongs to the definition and stays up after the
sandbox ends. The two chips use different words, icons, and ink, so the local
preview and the durable link are not read as interchangeable. An agent with no
App Link gets the bar it had before.

The harness server reads the link from core's
`GET /v1/workflows/definitions/:id/app-link` through a new
`GET /api/workflows/:id/app-link` route. The definition id comes from the agent's
own `sapiom.json`, the API key stays server-side, and only an `https:` URL is
passed to the page. Any failed read (signed out, unlinked, unreachable, drifted
shape) shows no chip.
