---
"@sapiom/harness-desktop": patch
---

Update window: use the actual desktop app icon as the brand mark

The redesigned update window showed the SPA's `sapiom-mark.svg` (a different, green mark) in a themed chip. It now shows the app's own `icon.png` — the black rounded-square "S" badge — copied beside the renderer and referenced same-origin, so the window's logo is identical to the dock/installer icon and can't drift from it.
