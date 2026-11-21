---
"@sapiom/browser-pay": patch
---

Document how to run the checkout browser: headed, with a persistent profile and the browser's own User-Agent, handing the checkout to the buyer at a bot check. The unpublished `examples/attach.ts` now opens its Sapiom browser headed with no other browser options, and takes an optional `BROWSER_PROFILE_ID` to restore a saved browser profile.
