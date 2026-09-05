---
"@sapiom/harness": patch
---

A project row's remove verb is a hover action, not an overflow menu. The `⋮` on every project row opened a 248px card to hold a single item — on plan-first projects its create item is suppressed, because the Agent Map owns creation, so the popover existed to carry one `Remove … from the rail`. That verb is now an `X` beside the session shortcut, hover-revealed like every other row action, and it opens the same confirmation as before: the project named, the count of running sessions it will end, and the statement that nothing on disk is touched.

Row actions state their subject in the accessible name and the tooltip rather than in visible menu text. The `project-remove-{label}` testid is unchanged and now belongs to the button itself; `project-menu-{label}` and `project-menu-card-{label}` are gone, as is the `openProjectMenu` e2e helper.

Follows design-eng D33: a project row's verbs are hover actions on the header, and a per-row menu would be a new idiom.
