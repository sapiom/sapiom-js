---
"@sapiom/harness": patch
"@sapiom/harness-desktop": patch
---

The project map opens on macOS and Windows when Studio holds the project folder under a different spelling of the same path. On macOS, temp folders sit behind `/var` → `/private/var`. Studio now compares the real paths.
