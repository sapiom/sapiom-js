---
"@sapiom/browser-pay": minor
---

`attachInterceptor` now takes a DevTools discovery URL (`http://` or
`https://`), as `chromium.connectOverCDP` does. It reads the WebSocket URL from
`json/version/` under the URL's path, with the query kept. An `https://`
discovery URL uses TLS and must name a `wss://` WebSocket URL. Before, an
`https://` URL went out as plain HTTP to port 80, query string included.

An `http://` or `https://` URL whose path ends in `/devtools/browser/<id>` or
`/devtools/page/<id>` is connected directly over `ws://` or `wss://`, so an
`http://` DevTools URL that worked before still works, also behind a proxy path
prefix. Any other `http://` URL is now read as a discovery URL: if it pointed at
a WebSocket at another path, pass it as `ws://` instead. A URL with any other
scheme is now refused before a connection opens.
