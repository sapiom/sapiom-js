---
"@sapiom/harness": patch
---

Studio: "New session…" moves from the Sessions menu to the Add menu.

Starting a session is the most common thing the rail's `+` is pressed for, and it is unambiguously an *add* — but it lived in the History popover, one button over. That was an accident of order: the Sessions menu existed first, so the action was put where there was already a list to put it in. The result was the thing you do daily sitting behind the button for reviewing work that has already finished, and "start something new" split across two popovers that look identical and mean different things.

It now leads the Add menu, above the three workspace doors, and is gone from the Sessions menu — one action, one home. The Sessions popover is left doing exactly one job: reopening a past session.

The row is the same `DoorRow` component as the doors beside it rather than a hand-matched copy of the markup, so it cannot drift out of alignment with them; `DoorList` takes a `leading` slot for rows that belong to the menu but have no door in the dialog.
