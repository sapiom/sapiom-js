---
"@sapiom/harness": patch
---

Fix two issues on the Templates screen in Studio:

- The info (i) spec sheet popover rendered with no surface — its background,
  border, and shadow were missing, so the Steps / Trigger / Complexity /
  Capabilities list and the Preview / Use buttons painted directly over the card
  behind it. `.template-facts` now opts into the shared popover elevation recipe.
- The Templates destination hid the workbench, but the rail's other nav actions
  never cleared it, so clicking Create new, Search, or an agent/session row left
  you stranded on the browser until you used the back arrow. Navigating anywhere
  now dismisses the Templates screen the same way the back arrow does.
