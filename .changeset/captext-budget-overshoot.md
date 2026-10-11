---
"@sapiom/mcp": patch
---

Fix `capText` (used by `sapiom_dev_agents_inspect` to bound expanded/previewed
step fields) appending its truncation marker after slicing to the budget
instead of within it, so a capped field could exceed its own char budget by
the marker's length — worse with a `webappUrl`, since the marker then also
carries the URL. Reserves room for the marker inside the budget before
slicing, so a capped field never exceeds the budget it was given.
