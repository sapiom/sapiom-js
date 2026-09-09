# Agent Map authority and retirement gate (SAP-3089)

The current Studio server owns one durable Agent Map per project. Its state
response always includes `studioProjects`, including an empty list when the
catalog cannot be read. A missing identity is an unavailable map, not permission
to infer a project from its name or serve a second topology.

## Release boundary

The server retirement in [#892](https://github.com/sapiom/sapiom-js/pull/892)
and client recovery in [#893](https://github.com/sapiom/sapiom-js/pull/893) must
ship together. Merge both before merging a Harness version PR, publishing npm
packages or tagging a desktop release. The server-only layer still has a
bundled browser fallback that reaches the retired endpoint on catalog failure.

The server layer carries `.changeset/quiet-project-map-authority.md`, marking
the documented HTTP endpoint removal as a **breaking minor** with replacement
APIs, even when other patch changesets are pending. Its `.release-blocked` file
makes `scripts/assert-release-ready.mjs` fail before versioning or publishing.
The local version/release commands and the Release PR, npm Publish and Desktop
Release workflows all run that check. The client layer removes the blocker
together with the unavailable-map recovery. Its recovery changeset remains a
patch; the combined Harness release takes the higher minor bump.

## Authority matrix

| Journey | Authority and disposition |
| --- | --- |
| New project | Durable project and map storage. Creation owns bootstrap; selecting the project never starts or selects a conversation. |
| Existing generated or authored map, including deliberately cleared maps | Existing aggregate, versions/events and private bindings. Viewing does not reinitialize or rewrite history. |
| Supported outer format 1 or exact unused wrapped format 2 | Existing protected reset/conversion rules and backup journal. Authored, malformed, future or uncertain formats are not overwritten. |
| Alias or explicitly associated additional/moved project root | Durable project ID continues to select the map. Root reassociation does not promise automatic migration of implementation IDs. |
| Exact agent move | Preserve the existing private agent ID through the authenticated move operation. Changed, missing, stale, foreign or ambiguous IDs remain unresolved. |
| Missing project identity, ambiguous scope, unsafe path or unavailable catalog | Show an unavailable Agent Map with a project-catalog retry. Keep ordinary sessions and per-agent Canvas reachable through explicit selection. Retry promotes only an exact server-issued workspace-key/project-ID association. |
| Selected durable map disappears from the catalog | Keep that selected ID and offer catalog retry. Explicit agent/session selection still opens its ordinary Canvas/Steps. |
| Current server receives old graph GET, refresh or navigation | The handlers and graph runtime are removed. The boot-token gate still returns 401 without valid authentication; authenticated calls receive the generic API 404 instead of the former 410 tombstone or SPA HTML. |
| Older server omits `studioProjects` entirely | The browser offers the same identity recovery, preserving the selected project and conversation. There is no fallback renderer or implicit session handoff. Ordinary session tabs remain available. |

Old graph events are ignored before browser state, cache invalidation
or other refresh handlers run. Shared discovery, accepted source evidence,
PackageInventory, rail launch edges, ordinary sessions and each agent's
Canvas/Steps retain their own consumers; they are not legacy project topology.

SAP-3090 disconnects `WorkspaceGraphView` from the shell and removes the
older-protocol session handoff at `42fcaccf`. The following layer deletes the
renderer, parser, layout, loader, navigation, announcement state, API methods,
mock topology and graph-only tests. Shared viewport behavior and its tests now
live together in `graph-viewport.ts` / `graph-viewport.test.ts`; Agent Map owns
the labels and controls it still uses. `agent-map-authority.spec.ts` includes omitted-catalog recovery
and exact keyboard tabs; `project-altitude.spec.ts` preserves pane geometry,
Steps restoration, independent disclosure and map/agent Back/Forward navigation.

SAP-3091 extracts the retained owners before deleting server composition:

| Retained module | Responsibility |
| --- | --- |
| `shared/workspace-scope.ts` | Scope keys, the public `WorkspaceScopeSummary` shape, and browser-safe workspace-relative identities. |
| `core/workspace-scope-catalog.ts` | Stable canonical-root keys and allowlisted root resolution. |
| `core/workspace-path.ts` | Source containment and canonical source-root selection for shared discovery/watchers. |
| `core/canvas-interconnections.ts` | Per-agent invocation modes and source scanning for Canvas. |

The public PackageInventory contract remains in `@sapiom/agent`. Canonical path
caching, accepted discovery evidence, shared watch leases and individual-agent
Canvas extraction keep their existing owners and regression coverage.

## Evidence required before browser deletion

Attach results to SAP-3089 at the reviewed PR head. Do not treat the presence of
this file as evidence that a host or recovery exercise passed.

| Gate | Reproducible evidence |
| --- | --- |
| Missing identity, exact recovery, unchanged conversation and no old requests/events | `web/e2e/agent-map-authority.spec.ts`; browser network observation starts before boot and counts old read, refresh and navigation requests. Old event frames must leave catalog/workflow fetch counts, selection and session actions unchanged. |
| Exact node navigation, error rejection and session parity | `web/e2e/agent-map-navigation.spec.ts`, including Claude, Codex, archived/no sessions, delayed responses, Info/resource inspection and mobile. |
| Current HTTP authority and retained root/descendant sessions | `src/server/studio-workspace-wiring.test.ts`; 401 without authentication and API 404 with authentication on all three removed routes, while durable identities and sessions remain intact. |
| Shared discovery still works without the legacy API | `src/server/workspace-discovery-freshness.test.ts`, `workspace-rescan.test.ts` and core workspace-watch broker/watcher suites. Preserve cold reads, edits/renames/deletes, superseded scan budgets, repository boundaries, lease retirement and symlink deduplication. |
| Existing-project initialization and restart/storage safety | Existing `agent-map-initialization`, `agent-map-empty-legacy-container`, `studio-project-catalog`, `studio-workspace-preferences` and `agent-map-implementation-bindings` suites. Record fresh runs; SAP-3082/3084 explain their accepted identity/move limits. |
| Packaged host | Desktop `--smoke` uses the shipped SPA and real saved-map APIs. Its map check records zero legacy reads/refreshes/navigation across entry, inspection, reload/origin changes, failures/retries and project switches; direct old requests must return 404. Record package version, revision, report and artifact. |

The Linux packaged run is Linux evidence. The required signed/notarized macOS
installer and its upgrade journey remain release validation, not an inference
from a Linux result. Record that platform's evidence in SAP-3086 before shipping.

## Candidate evidence — 2026-09-09

The server fence is commit `d3c91355`, based on main `65219660`. Browser code,
screenshots, and this record are reviewed together in the next stack layer.
This records implementation evidence; the SAP-3090 deletion decision still
requires review of that final head and its CI.

- Root build, typecheck and lint passed, including the final Harness browser
  rebuild. Terminology and provider-copy checks passed.
- The root test command stops at `agent-core/src/bundle-error.spec.ts`'s
  unreadable-directory assertion. The same failure reproduces on the unchanged
  prior checkout. Remaining packages were run separately; this limitation must
  stay visible in the PR validation, rather than calling the root command green.
- Harness: all **3,994** unit/integration cases passed across the full run and
  focused retries; all **10** isolated performance cases passed. CPU contention
  caused a discovery timeout, and a concurrent storage test hit `ENOSPC`; the
  affected two files then passed together (**118** cases).
- Browser: the full run passed **644/648**, with four template startup timeouts;
  the entire template file then passed **23/23**. The final authority file passed
  **8/8**, including two additional keyboard cases. All **650** current browser
  cases passed across the full run and scoped reruns.
- Browser verification uses the repository's full Playwright suite, installed
  Chrome, and isolated ports. Dedicated authority tests count calls before cache
  hits and cover missing identities, cross-project recovery, late responses,
  keyboard tabs, ordinary Canvas/Steps, and legacy event rejection.
- Linux x64: Harness `0.16.0`, desktop `0.4.6`, Electron `33.4.11`. Both the
  packaged `linux-unpacked` app and the actual AppImage wrapper (extract-and-run
  under Xvfb) passed 16 checks; the Windows-only shim check was skipped. Agent Map
  reported legacy read/refresh/navigation counts **0/0/0**, all direct legacy
  requests **410**, and unchanged saved map/history across viewing. The bundled
  server, SPA index and JavaScript asset were compared byte-for-byte with the
  final build. The smoke session uses the repository's coding-agent stub.

AppImage SHA-256: `d5b8a9788172b32a8872e04428ad52f48c2da32028983dbb93b6e9ccbed2f36c`.

## Stop conditions and retained owners

Stop deletion for a wrong map/target, a path exposed in public map JSON, an
implicit session action on map entry/retry, changed history on viewing, a current
project making legacy requests/event refreshes, or a discovery/watcher regression.
An unavailable identity must remain a bounded error throughout recovery.

| Owner | Retained responsibility |
| --- | --- |
| SAP-3082 | Catalog identity, saved selection, private implementation bindings and protected resolution. |
| SAP-3084 | Node inspection/navigation and ordinary conversation/Canvas behavior. |
| SAP-3087 / SAP-3088 | Discovery freshness and shared workspace watcher ownership. |
| SAP-3090 | Browser rendering, loaders, API methods, announcements and fixtures are removed in two dependent layers. Human review follows the complete cleanup stack; implementation does not authorize release. |
| SAP-3091 | Remove the unreachable graph runtime/router/store/invocation wiring; retain shared discovery, rail and per-agent graph helpers. |
| SAP-3086 / E8 assignee | Package/upgrade evidence, release decision, recovery owner and out-of-hours approver. Approval must be recorded, not assumed. |

## Recovery decision

Follow [the release and recovery contract](./rollout-rollback.md). There is no
cohort flag or in-place package downgrade. Restore product state only through
ordinary expected-version restores, which append history. Recover a faulty
binary by reverting its commit on a new branch, adding a new changeset, and
releasing strictly higher package and desktop versions.

A local rehearsal can prove the revert, changeset/version generation and tag
preparation in a disposable checkout. It cannot prove that an update has been
published or that installed desktops can download it. Record those separately,
including retained installers, manifests/blockmaps, release links and the named
approver. Neither PR creation nor a green smoke check authorizes a release.

## Recovery exercise — 2026-09-09

In a separate local Git clone, reverted `d3c91355` and verified that all server
sources matched pre-change `65219660`. Added a new Harness/desktop changeset,
ran the real `pnpm version-packages` command (version generation, fallback
constants and lockfile update), and committed its output on the local
`changeset-release/main` branch. This produced Harness **0.16.1** and desktop
**0.4.7**, both strictly higher than the candidate's package versions. Created
matching local tag **v0.4.7** at version commit
`1156fa84cdf328d431968d8dadd5361b3ee03253`.

Those version numbers belong to the original local rehearsal, before the
breaking minor classification. They are not recovery versions for a published
minor release. Final release validation must choose recovery package and
desktop versions strictly above the versions that actually ship.

No recovery branch, version PR, tag or package was published. This proves the
local preparation sequence, not update delivery. The actual npm/version-PR and
desktop publication, retained installer/manifests/blockmap checks, signed macOS
upgrade journey and named release approver remain SAP-3086 release gates.
