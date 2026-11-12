---
"@sapiom/agent-core": patch
"@sapiom/harness": patch
"@sapiom/tools": patch
---

Remove links to retired docs.sapiom.ai capability pages, which now redirect to the Sapiom Pay docs home. The agent-authoring and sandbox-preview skills (and their scaffold template copies) no longer point at the capability catalog or App Links pages. Agent Studio's bundled system prompt drops its App Links link, and its command palette Docs tab no longer lists the retired AI models page. The footer still opens the docs site. A `liveViewUrl` doc comment in `@sapiom/tools` drops its `@see` link.
