---
"@sapiom/harness": minor
---

Agents nested deep under a project root are discovered again: the scan now reaches 8 levels, bounded by a node budget rather than by depth alone.

`AGENT_PROJECT_SCAN_MAX_DEPTH` was 3, which predated the project-rooted rail — it assumed the directory you opened was roughly the agent's own folder. Under a root you *choose*, depth is ordinary: `<root>/backend/src/agents/<agent>` is four segments down and `<root>/apps/<app>/src/features/<x>/agents/<agent>` is six. Those agents were not found at all and landed in "No workspace" — on a measured root, well over a third of the rail.

Raising the depth alone would not have been affordable, and the numbers are why. Measured against real roots (macOS/APFS, warm cache, ~22-25 µs per directory entered):

| root | depth 3 | depth 8 | unbounded |
| --- | --- | --- | --- |
| a single repo | 119 dirs | 242 dirs · 7 ms | 242 dirs |
| a monorepo | 758 dirs | 9,016 dirs · 196 ms | 9,195 dirs |
| a monorepo with worktree copies | 1,298 dirs | 35,489 dirs · 847 ms | 47,544 dirs |

So cost is linear and predictable in *directories entered*, and that is now what is bounded: `AGENT_PROJECT_SCAN_MAX_NODES` (10,000) for the registry scan, and a tighter `AGENT_PROJECT_WATCH_MAX_NODES` (2,500) for the workspace watcher's fingerprint, which is synchronous and re-runs on a debounce after every save. Pruning harder was the other candidate and does not pay — extending the ignored-directory list with the usual suspects removed 0.5–11% of the directories on those roots.

The registry and the watcher now share one traversal in `core/agent-project-discovery.ts`, and it is **breadth-first**, which is what makes the budget safe: every level shallower than the cut is complete, so a truncated scan degrades by depth exactly as the fixed cap did — just at a depth the tree's real width chooses instead of one guessed in advance. A scan reports how far it got (`AgentProjectScanBudget.envelopeDepth`) and the registry reconciles only within that, so a bounded scan never mistakes "I did not look there" for "it is gone".

Termination on a pathological tree does not depend on the cap: subdirectories are filtered on raw dirent type, so a symlink — including one closing a cycle — is never descended into. That is now asserted directly, and `src/core/agent-project-scan.perf.test.ts` measures the cost of both bounds on a deep monorepo fixture next to the depth-3 baseline.
