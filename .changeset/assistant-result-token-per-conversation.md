---
"@sapiom/harness": patch
---

Assistant chats bind the result marker to the conversation instead of to each message. A model that repeats the marker from an earlier answer no longer has a finished answer read as missing, so it no longer triggers a hidden recovery turn or shows Stopped.
