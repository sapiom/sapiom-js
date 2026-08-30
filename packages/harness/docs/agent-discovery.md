# How Agent Studio finds, registers and tracks your agents

This document answers, in order, the questions that get asked when the rail
shows the wrong number of agents:

1. [How is an agent discovered?](#1-how-is-an-agent-discovered)
2. [What happens when I create a new agent?](#2-what-happens-when-i-create-a-new-agent)
3. [How is it tracked afterwards, and how does an entry ever leave?](#3-how-is-it-tracked-afterwards)
4. [What are the bounds, what do they cost, and what is _not_ scanned?](#4-the-bounds-what-they-cost-and-what-is-not-scanned)
5. [What changed, and what did not](#5-what-changed-and-what-did-not)

Important implementation claims below name their owning module. If the code and
this document disagree, the code is right and this document is a bug.

---

## 1. How is an agent discovered?

### What proves a directory is an agent

Studio uses two ordered proofs:

1. A valid **`sapiom.json`** directly inside the directory is authoritative.
   It wins without reading TypeScript and stops descent below that agent.
2. When the marker is absent or invalid, a regular, non-symlink `index.ts` may
   prove exactly one exported agent definition created by `defineAgent` or the
   legacy `defineOrchestration` API. This fallback is syntax-only: Studio parses
   TypeScript ASTs and never bundles, typechecks, dynamically imports, or
   executes project code merely to discover it.

An unresolved/dynamic export, ambiguous definition, transient read failure, or
exhausted analysis budget is **incomplete**, not "not an agent". Existing rows
under that uncertain envelope survive until a later scan can prove the answer.

"Has a `sapiom.json`" is stricter than it sounds
(`inspectAgentProjectMarkerSync`, `src/core/agent-project-discovery.ts:237`):

- it must be a **real file** — an `lstat` that reports a symlink is rejected
  rather than followed, so a link cannot make a directory outside the scan
  masquerade as an agent inside it;
- its contents must **parse as JSON whose top-level value is an object**
  (`{}` counts; `[]`, `null`, `"x"` and a truncated write do not);
- the read is resolved to a path proven to sit inside the directory being
  inspected (`resolveAgentProjectMarkerPath`, `agent-project-discovery.ts:210`).

The result is a three-state answer, not a boolean: `valid`, `absent`/`invalid`,
or **`unreadable`**. The third state exists so a permissions error or a
momentary I/O failure is never mistaken for "this agent was deleted" — see
§3.

Everything the marker carries — `definitionId`, `name`, `templateId`, `forkId`,
`starterId` — is provenance written by `link`, `clone` or `scaffold`. None of it
affects _whether_ a valid marker is authoritative. A syntax-only row has null
cloud metadata. If a connected row also has syntax proof, its source name is
canonical while its retained marker/cloud slug remains a compatibility alias.

The syntax resolver follows only supported relative TypeScript re-exports and
aliases within the selected workspace. It never crosses ignored directories,
symlink components, or a nested repository checkout. Bare-package or otherwise
unresolved export structure fails closed rather than guessing.

### Who walks the tree

One traversal, shared by every surface that needs it, so the registry, the live
watcher and the folder picker can never disagree about which directories a scan
of a given root covers: `walkAgentProjectTree`
(`agent-project-discovery.ts:446`) and its async twin
`walkAgentProjectTreeAsync` (`:479`).

It is **breadth-first**, and that is load-bearing rather than stylistic — see
§4. At each directory it asks the caller what to do, and stops descending on
three answers:

| It stops at                                         | Because                                              |
| --------------------------------------------------- | ---------------------------------------------------- |
| a directory with a valid marker                     | that is the agent; agents do not nest                |
| a directory with one syntax-proven exported agent   | that is the agent; agents do not nest                |
| a directory whose marker is `unreadable`            | the whole subtree is treated as opaque for this pass |
| a directory that is **its own repository checkout** | it belongs to a repo you did not ask about — see §4  |

and it never enters `node_modules`, `.git`, `.sapiom`, `dist`, `build`, `.next`
(`IGNORED_DIR_NAMES`, `agent-project-discovery.ts:154`), nor any symlink —
`entry.isDirectory()` reads the raw dirent type, so a symlinked directory
reports `false` and is skipped. That, not the depth cap, is what makes a symlink
cycle terminate.

### Where a scan is rooted

**This is the part that actually decides what you see.** A scan only ever covers
the tree beneath the root it is given, so the whole question is "who chose the
root". There are eight scan reasons, plus one direct connection mutation:

| Reason             | Root                       | Fires when                                                                |
| ------------------ | -------------------------- | ------------------------------------------------------------------------- |
| `boot`             | the launch directory       | server start (`src/server/index.ts:1174`)                                 |
| `session-create`   | the new session's `cwd`    | `POST /api/sessions` (`index.ts:1305`)                                    |
| `workspace-change` | a live session's `cwd`     | the workspace watcher saw the marker set change (`index.ts:889`)          |
| `agent-linked`     | that one agent's directory | a deploy wrote a `definitionId` into its marker (`index.ts:1418`)         |
| `agent-connected`  | that connected directory   | a manual connection settles its current marker/source evidence            |
| `agent-moved`      | the destination's parent   | a rail drag moved an agent on disk (`index.ts:1468`)                      |
| `graph-refresh`    | the selected Project root  | first graph access, a source/inventory change, or explicit graph refresh  |
| `requested`        | whatever folder you named  | `POST /api/workflows/scan` — the **"Add all N"** button (`index.ts:1365`) |

`POST /api/workflows/connect` first mutates exactly one path —
the **"Add workspace"** button. It applies the same marker-first, syntax-only
proof and freshness rules, then its `agent-connected` scan reconciles and
publishes the accepted inventory.

Every one of those logs a line naming its reason, its root, what it found and
what it cost (`logAgentScan`, `index.ts:305`):

```
[harness] agent scan (boot) /Users/you/wf-demo-testing: 10 agent(s), 26 dirs
[harness] agent scan (requested) /Users/you/sapiom: 68 agent(s), 408 dirs
```

If the rail has rows you do not recognise, that log says which root put them
there. It exists because reconstructing the answer after the fact once took a
filesystem archaeology session.

---

## 2. What happens when I create a new agent?

An agent can appear by writing a marker, or by adding a markerless `index.ts`
whose exports satisfy the syntax proof above. **Nothing about creation talks to
the registry.** The registry finds out the same way it finds out about
anything: something scans.

### With the studio running (the normal case)

1. Your coding agent (or you) writes the marker or relevant TypeScript somewhere
   under the session's `cwd`.
2. The **workspace watcher** for that session sees a filesystem event
   (`SessionWorkspaceWatcher`, `src/core/workspace-watcher.ts:182`). A raw event
   only _arms_ a check — it does not itself mean anything, because recursive
   `fs.watch` on macOS reports `rename` for ordinary content writes too.
3. After a short debounce it recomputes a bounded asynchronous fingerprint of
   markers, candidate `index.ts` files, and the accepted relative dependency
   observations needed to revisit split definitions. A raw relevant event
   fail-closes affected graph navigation immediately; the expensive fingerprint
   and reconciliation stay off the event callback.
4. That calls `rescanWorkspaceForSession` (`index.ts:889`), which prunes dead
   paths, rescans the session's `cwd`, rewrites every open session's
   `harness-context.json`, and broadcasts `workflows.changed`. The SPA refetches
   `/api/workflows` on that event.

**Measured end to end** on a real server: a new marker written six levels deep
(`apps/web/src/features/billing/agents/invoice-chaser`) inside a live session's
cwd appeared in `GET /api/workflows` within about a second, with no restart.

On Linux, or if the watcher errors, the same check runs on a 2 s poll instead —
same fingerprint and reconciliation rules, slightly slower. Missing,
unreadable, symlink, and non-file observations remain distinct so a recovery or
confirmed deletion cannot be swallowed as "unchanged".

There is one more trigger for the same case: a session's **first** transition to
`running` runs one rescan unconditionally (`index.ts:995`). The watcher captures
the markers already present as its baseline and only fires on a _later_ change,
so a session that starts in a folder where the agent already exists (a
just-cloned template) would otherwise never trigger anything.

### With the studio not running

Nothing happens at creation time. The agent is registered by the next scan whose
root contains it — in practice the `boot` scan, if you launch the studio in a
directory above it, or the `session-create` scan when you open a session there.
If it is nowhere near either, it stays unregistered until you point **Add
workspace / Add all** at it. That is not a failure mode; it is the design in §4.

### If the new agent is its own git repository

A valid marker is inspected _before_ the repository boundary is considered, so
a marker-backed agent in a nested checkout is still registered by the containing
workspace scan. Static source discovery deliberately does not enter a foreign
checkout: select a markerless agent repository as its own workspace to prove it.
If a source-only folder previously discovered by its parent later runs
`git init`, the next parent scan retires that parent-owned row until the new
repository is selected directly. This asymmetry keeps syntax reads confined to
the selected repository while preserving the established marker behavior.

---

## 3. How is it tracked afterwards?

The registry is a plain JSON array at `<state-root>/workflows.json`
(`~/.sapiom/harness/workflows.json` by default), written atomically via a
temp-file rename so a crash mid-write cannot tear it
(`WorkflowRegistry.persist`, `workflow-registry.ts:274`). Every mutation goes
through a single write queue, so a concurrent scan and prune cannot interleave
and drop entries (`enqueue`, `:288`).

Each public entry records where it came from in its `source` field: `"scan"` (a
walk found it) or `"connect"` (you named it). Private source-name, marker-proof,
canonical-path, observation, and completeness evidence lives in the registry
and accepted inventory sidecars; it is never serialized by `/api/state` or
`/api/workflows`.

### What adds entries

`scan()` (`workflow-registry.ts:344`) and `connectPath()` (`:390`). Nothing else.

`scan()` **merges** rather than replaces: entries outside the scan's reach
survive it. That is deliberate — a scan of one project must not delete the
agents of another — but it is also why the registry is the union of every root
ever scanned over the life of an install, and why an over-broad scan is
expensive in a way a single bad session is not. It is a file you have to _clean_,
not one that resets.

### What removes entries

Three things, and they are deliberately narrow:

1. **The missing-path sweep** (`partitionByPathExists`, `:233`). Only a
   **confirmed-missing** path goes — `ENOENT` or `ENOTDIR`. A directory that
   exists but is unbuilt, unreadable, or momentarily unstattable is kept, because
   losing a real project to a transient filesystem error is far worse than
   carrying a dead row for one more sweep. It runs:
   - at server boot, before the first `list()` (`index.ts:582`);
   - on **every read**, at most once every 30 s (`LAZY_PRUNE_INTERVAL_MS`,
     `workflow-registry.ts:225`, applied in `list()`, `:305`);
   - on **every scan**, registry-wide rather than only within the scanned tree
     (`:377`) — so a dead row rooted somewhere the studio will never scan again
     still leaves;
   - on a session workspace change and after an agent move (`index.ts:895`,
     `:1467`).
2. **Scan reconciliation** (`isCoveredByScan`, `:171`). A `"scan"`-sourced entry
   whose marker is gone or has become invalid is dropped — but _only_ if this
   scan can prove it would have looked there. Three things protect an entry from
   that proof: it sits deeper than the scan actually reached
   (`budget.envelopeDepth`), it sits beneath a subtree that was unreadable on
   this pass, or it sits **inside a repository checkout this scan declined to
   enter** (`isProtectedByIncompleteScan`, `workflow-registry.ts`). Without that last one,
   opening `~/src` after having opened `~/src/some-repo` would delete that repo's
   agents.
3. **Removing a project in the rail**, which is a client-side concept: it drops
   the root from `recentDirs` and hides its subtree. It does not delete anything
   on disk and does not empty the registry.

### An entry whose directory was deleted, renamed, or moved

- **Deleted** — the path is confirmed missing, so the next sweep drops it. In
  practice that is within 30 s of the next read, without a restart. (Verified on
  a real server: an agent deleted outside any watched session's cwd disappeared
  from `GET /api/workflows` 33 s later with no scan and no restart.)
- **Renamed or moved by hand** — this is a delete _and_ a create. The old path
  is pruned; the new one is registered by whichever scan next covers it. A live
  session's `boundWorkflowPath` pointing at the old path is cleared rather than
  left dangling (`index.ts:911`).
- **Moved by a rail drag** — handled explicitly and does not go through that
  gap: sessions under the old path are remapped, the old path is pruned, and the
  destination is rescanned in one step (`index.ts:1465`).

Note the asymmetry: **removal needs proof, registration does not.** That is the
right way round for not losing your work, and it is exactly why the _breadth_ of
a scan matters so much — see §4.

---

## 4. The bounds: what they cost, and what is not scanned

Three bounds, and it is worth being precise about which one does what, because
the intuitive answer ("the depth limit") is wrong.

### Depth: `AGENT_PROJECT_SCAN_MAX_DEPTH = 8` (`agent-project-discovery.ts:30`)

This was 3 until round 1. Three assumed the root you opened was more or less the
agent's own folder, which stopped being true when the rail became project-rooted:
an agent sits at `<root>/backend/src/agents/<agent>` (4 segments) and
`<root>/apps/<app>/src/features/<x>/agents/<agent>` is 6. At 3, those agents
were not found at all.

**Depth is not what keeps a scan cheap.** What it buys is a pathological deep
chain terminating in 8 steps rather than by exhausting a budget, and a
deterministic outer envelope for reconciliation.

### Directories entered: `AGENT_PROJECT_SCAN_MAX_NODES = 10_000` (`:76`)

The bound that governs cost. Per directory entered = one `lstat` + one `readdir`,
~22–25 µs warm at every depth, so cost is linear and predictable in _directories
entered_ and that is what is bounded.

Past the budget a scan is incomplete. Because the walk is breadth-first, the
budget degrades by **depth**: every level above the cut is complete, and the scan
reports how far it got as `budget.envelopeDepth`. Nothing beyond that is
reconciled away as missing.

The watcher walk is asynchronous and bounded over the same 10,000-directory
candidate envelope, so polling cannot permanently miss a candidate the scanner
would admit. Dependency observations have their own bounded, scope-confined
metadata projection; multiple sessions and graphs sharing a canonical root
reuse one watcher rather than multiplying filesystem walks.

### Syntax analysis budgets

Syntax fallback has independent deterministic limits:

- relative re-export depth: 8;
- per candidate: 32 unique TypeScript modules and 1 MiB;
- per workspace scan: 2,000 unique TypeScript modules and 16 MiB;
- parsed-summary LRU: 10,000 entries.

Warm cache hits avoid physical reads/parses but spend the same logical scan and
candidate budgets as cold reads. Shared modules spend the workspace budget once
and each candidate budget once. Hitting any limit degrades completeness and
protects unresolved prior rows; it never turns uncertainty into deletion.

### Repository boundary (`isForeignRepositoryRoot`, `:150`)

**A scan covers one repository.** Below the root, a directory carrying a `.git`
entry — a directory in an ordinary clone, a file in a worktree or submodule — is
not descended into. The root itself is always exempt: a scan of a repo covers
that repo.

This is the round-2 addition, and it is the one that changes what you see.
Measured on one real install (macOS/APFS, warm cache, at the 10,000-node budget).
Cells are _agents registered / distinct names among them / directories entered /
wall clock_:

| root                                      | before                                                  | after                                |
| ----------------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| `~/sapiom/wf-demo-testing` (a launch dir) | 10 / 10, 17 dirs, 0 ms                                  | 10 / 10, 17 dirs, 0 ms               |
| `~/sapiom` (a parent of it)               | 88 / 65, 10,000 dirs, 239 ms — **truncated at depth 5** | 68 / 64, 408 dirs, 8 ms — complete   |
| `~/sapiom/sapiom-js` (a monorepo)         | 25 / **2**, 9,016 dirs, 233 ms                          | 2 / 2, 444 dirs, 8 ms                |
| `~/sapiom/Sapiom`                         | 0 / 0, 10,000 dirs, 200 ms — **truncated**              | 0 / 0, 5,408 dirs, 107 ms — complete |

The `sapiom-js` row is the whole argument. Of the 25 agents a scan of that repo
used to register, **24 were the same agent** — one e2e fixture, reachable once
per git worktree under `.trees/`. Two were real. Reading the distinct-name column
down the table: the boundary barely changes how many _agents_ a scan finds and
collapses how many _rows_ it writes.

Raising the node budget makes this worse, not better: uncapped, `~/sapiom` is 141
agents across 83,969 directories in 6.8 s — and still only 73 distinct names.

### What is _not_ scanned, stated plainly

- anything below a directory that already has a marker;
- `node_modules`, `.git`, `.sapiom`, `dist`, `build`, `.next`, and anything under
  them;
- anything reached only through a symlink;
- anything more than 8 levels below the root;
- anything past 10,000 directories on one scan or watcher candidate walk;
- **anything inside a git checkout that is not the one you pointed at.**

The last is the only one that loses whole agents rather than duplicates. On the
install measured above it costs 5 distinct agents at `~/sapiom` and the single
agent under `~/sapiom/Sapiom`. Each of them lives inside a checkout below the
scan root, and each is registered the moment that checkout is itself the root:
launch the studio there, open a session there, or name it to **Add workspace**.

That is the trade the user asked for in as many words — _"It's okay if we don't
fully scan."_ The rule it buys is worth stating on its own:

> **An agent is in your registry because you opened its folder, created it, or
> asked for a scan that covers it — never because a walk wandered into a
> neighbouring repository.**

### How an agent outside any scan still gets registered

Three ways, all of them explicit:

1. **Add workspace** (`POST /api/workflows/connect`) — registers that one
   directory, with no walk, no bounds, and no requirement that it have a marker
   yet.
2. **Add all** (`POST /api/workflows/scan`) — walks the folder you named, under
   all three bounds above.
3. **Open a session in it** — `session-create` scans that cwd, and the workspace
   watcher keeps it current for as long as the session lives.

---

## 5. What changed, and what did not

### Round 1 did not "remove the depth scan"

It is worth being blunt about this, because the opposite belief is also wrong.
Round 1 **raised** the depth cap from 3 to 8, and added two things beside it: a
10,000-directory budget (`AGENT_PROJECT_SCAN_MAX_NODES`) and `envelopeDepth`, the
scan's own report of how deep it actually got, so reconciliation could only
delete rows the scan could prove it had looked for. Round 1 gave the synchronous
marker watcher a tighter 2,500-directory budget; syntax reconciliation later
made that watcher asynchronous and aligned its candidate coverage with the
10,000-directory scan envelope so polling cannot miss an otherwise discoverable
agent forever.

So: **there is still a depth scan, and after round 1 it reached further than
before, not less far.** What round 1 changed was _what limits it_ — directories
entered rather than levels descended — and it made a truncated scan honest about
being truncated instead of silently deleting what it had not reached.

What round 1 did **not** change was scan _breadth_. A scan still followed its
root wherever that root led, across as many unrelated repositories as fitted in
the budget. That is what produced a registry of 88 agents spanning twelve
top-level directories nobody had opened, and six copies each of four agents from
six checkouts of one repo.

### Round 2

- **The repository boundary** (§4) — the scan now covers one repository, which
  is what stops sibling checkouts and worktree duplicates.
- **Reconciliation knows about it** — an entry behind a boundary this scan
  declined to enter is protected from removal, exactly like one below the
  truncation envelope.
- **Stale entries actually leave.** Round 1's note said the registry "prunes
  lazily". It did not: pruning only happened where a caller remembered to ask
  (boot, a session workspace change, an agent move), so an agent whose directory
  you deleted could sit on the rail until the next restart. `list()` now sweeps
  confirmed-missing paths at most every 30 s, and `scan()` sweeps registry-wide.
- **Every scan says why it ran**, on stderr, with its root, its yield and its
  cost (§1).

### What is still true after round 2

- A scan **merges** into the registry; it does not replace it. An install
  accumulates roots over time, and clearing an over-broad scan means removing
  those projects, not waiting for a scan to undo it.
- Removal still requires proof of absence. An unreadable directory keeps its
  entry.
- Duplicate agent _names_ are still possible and still legitimate: open two
  worktrees of one repo as two projects and you will see the same agent twice,
  because you asked for both. What the boundary stops is getting them without
  asking. Disambiguating two legitimately-open copies in the rail is the SPA's
  job, not the registry's.

### Syntax discovery and live reconciliation

- Marker-first semantics remain intact. Only an absent or invalid marker falls
  through to source; an unreadable marker keeps the subtree opaque.
- Markerless current and legacy authoring APIs now enter the same registry,
  rail, graph, and revision-matched navigation lifecycle as linked agents.
- Discovery results and completeness publish as one accepted generation after
  context staging. Watcher races, overlapping roots, stale scans, and reverse
  browser responses cannot publish an older inventory over a newer one.
- Known inventory renders from memory immediately in a degraded graph while
  background discovery and bounded direct invocation extraction settle. No ordinary
  GET waits on a filesystem scan, project execution, or remote metadata fetch.
- Syntax-only/null-cloud rows never authorize automatic legacy Canvas or
  manifest extraction. Existing explicit valid-marker or cloud-link evidence
  retains that legacy path, with authorization rechecked at process launch.

### The one thing this document cannot tell you

A registry that was already polluted stays polluted. The boundary changes what
_future_ scans register; it does not retroactively remove what an earlier
over-broad scan wrote. Rescanning the root that caused it will now reconcile the
duplicates away — but only that root, and only if you point at it again.
Otherwise, remove those projects from the rail, or delete
`<state-root>/workflows.json` and let the boot scan rebuild it from the directory
you launch in.
