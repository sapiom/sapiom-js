---
"@sapiom/harness": patch
---

Studio: one vocabulary for adding a workspace, and the intent question asked once.

Two surfaces offered the same action under different names and different shapes. The rail's `+` opened a centred modal titled "Add to Sapiom" whose first door was "I have a project"; Overview's primary row said "Open a folder". Same destination, two words for it, and only one of them matched the button the user had just pressed.

- **The `+` is a menu, not a modal.** It now opens an anchored popover on the same `AnchoredPopover` primitive and the same `connect-card` recipe as the History menu one button to its left, which is what it always should have been: a centred, scrimmed dialog to pick one of three words was the heaviest possible container for the lightest possible choice, and it read as a different surface from its own neighbour. The rows are not a reworded copy — `DoorList` moved out of the dialog and is rendered by both, so the three labels cannot drift again.
- **It opens beside the rail rather than over it**, via a new `right-start` / `right-end` placement on `AnchoredPopover`. Every existing placement drops the panel above or below its trigger, which is wrong for a trigger pinned to a left-hand edge: the panel grows back across the workspace tree it is about to add to, covering the list you are checking against. Side placements align the panel's top edge to the trigger's and grow rightward; the existing measured clamp pass still shifts an overhanging panel back inside the viewport, so the width is deliberately not pre-clamped to the space remaining (which would squeeze the card narrow on a small window instead).
- **Overview's "Open folder" lands on the folder question.** It opened the door *list*, so clicking a button called "Open folder" was answered with three intents, one of which was opening a folder. `AddWorkspaceDialog` takes an optional `initialDoor` and both callers now pass the door they already named. Entered that way there is no list behind the door, so the back button is suppressed rather than left pointing at a state the dialog was never in.
- **Door 1 is "Open a folder" everywhere**, adopting the word Overview already used.

Recent workspaces, the templates hand-off, and every door's own flow are unchanged.
