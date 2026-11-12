---
"@sapiom/agent-core": patch
"@sapiom/harness": patch
"@sapiom/tools": patch
---

Remove links to retired docs.sapiom.ai capability pages, which now redirect to the Sapiom Pay docs home. The agent-authoring and sandbox-preview skills (and their scaffold template copies) no longer point at the capability catalog or App Links pages. Agent Studio's bundled system prompt drops its App Links link, and its command palette Docs tab no longer lists the retired AI models page. The footer still opens the docs site, and Enter on an empty palette tab with no query now runs that tab's footer action (Open documentation, Browse templates), so it stays reachable from the keyboard. A `liveViewUrl` doc comment in `@sapiom/tools` drops its `@see` link.
