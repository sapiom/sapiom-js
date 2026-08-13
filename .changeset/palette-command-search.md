---
"@sapiom/harness": minor
---

Command palette: a proper fuzzy finder, redesigned as Command Search

The Cmd+K palette is rebuilt around the reported search failures ("cannot find
this simple agent"): short queries no longer "match" characters scattered
across absolute paths, duplicate past sessions no longer flood the list, and
what you search is what the rail shows.

- **Boundary-gated matcher** (`web/src/lib/fuzzy.ts`): every matched character
  must be contiguous with the previous one or sit at a word/segment boundary,
  with a substring fallback for mid-word fragments. Scattered-noise matches are
  rejected outright, not merely down-ranked. Multi-term queries AND across
  whitespace.
- **Ranking model** (`web/src/lib/palette.ts`, new): rows carry display names
  (`displayAgentName`, `sessionDisplayName` — user renames are searchable);
  same-title same-folder past sessions collapse to the newest; sections order
  by their best hit with per-section caps (lifted when only one kind matches);
  recency is a bounded score bonus that never lifts a path-only match over a
  name match.
- **Command Search surface** (per the design-eng widget): a search bar with a
  clear button, filter tabs — All / Sessions / Agents / Templates / Docs /
  Files / Actions — cycled with Tab/Shift+Tab, and a shortcut-bar footer. App
  verbs (browse templates, toggle theme, panel toggles, new session here) are
  injected actions; the Templates tab lists the catalog and opens the gallery
  focused on a template; the Docs tab searches a short list of docs pages with
  the docs site as the footer destination.
- The active session is badged "current", demoted from the unqueried top spot,
  and never the default selection; matched characters render on an
  accent-tinted cap that stays legible on selected rows in both themes.
