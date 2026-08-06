---
"@sapiom/harness": patch
---

Fix the template card's spec sheet reading as unstyled text over the card. The `(i)` panel was the one AnchoredPopover caller missing from the shared popover recipe, so it opened with no background, border or shadow and the card's description showed through its figures. It now takes the same surface as every other floating panel, keeping only its own width and roomier padding.
