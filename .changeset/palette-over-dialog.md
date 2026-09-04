---
"@sapiom/harness": patch
---

The command palette no longer opens on top of an open dialog. Pressing its shortcut while a dialog is up used to stack the palette over it, and pressing Tab then walked out of the palette into the dialog behind. The shortcut now does nothing while a dialog is open, and is not handed to the browser. It still opens the palette over the Overview, which is unchanged.
