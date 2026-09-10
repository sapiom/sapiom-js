# Agent Map authority and source retirement (SAP-3089 / SAP-3090 / SAP-3091)

The current Studio server owns one durable Agent Map per project. Its state
response always includes `studioProjects`, including an empty list when the
catalog cannot be read. A missing identity is an unavailable map, not permission
to infer a project from its name or serve a second topology.

## Release boundary

The server retirement in [#892](https://github.com/sapiom/sapiom-js/pull/892)
and client recovery in [#893](https://github.com/sapiom/sapiom-js/pull/893) are
the foundation of the cumulative SAP-3090 / SAP-3091 cleanup stack. Review and
ship all seven layers together before merging a Harness version PR, publishing
npm packages or tagging a desktop release. The server-only layer still has a
bundled browser fallback that reaches the retired endpoint on catalog failure.

The server layer carries `.changeset/quiet-project-map-authority.md`, marking
the documented HTTP endpoint removal as a **breaking minor** with replacement
APIs, even when other patch changesets are pending. Its `.release-blocked` file
makes `scripts/assert-release-ready.mjs` fail before versioning or publishing.
The local version/release commands and the Release PR, npm Publish and Desktop
Release workflows all run that check. The client layer removes the blocker
together with the unavailable-map recovery. Its recovery changeset remains a
patch; the combined Harness release takes the higher minor bump. SAP-3091 also
adds `.changeset/quiet-retired-server-graphs.md`. Both retirement changesets
describe the final authenticated JSON API 404, which applies to every unknown
`/api` path. The intermediate 410 fence is not a separately published contract.

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

## Source-deletion boundaries

All layers were implemented on one cumulative working branch. Separate snapshot
refs keep the PR diffs reviewable; the final ref contains the complete stack for
local Studio validation. Human review is intentionally deferred until the
complete cleanup is available, as authorized by the maintainer.

| Ticket/layer | Revision | Change |
| --- | --- | --- |
| SAP-3090 1/2 ([#907](https://github.com/sapiom/sapiom-js/pull/907)) | `42fcaccf` | Remove browser entry points and older-server session handoff. |
| SAP-3090 2/2 ([#908](https://github.com/sapiom/sapiom-js/pull/908)) | `4c4b7190` | Delete unreachable browser topology and repoint retained viewport/styles/tests. |
| SAP-3091 1/3 ([#909](https://github.com/sapiom/sapiom-js/pull/909)) | `67337e6d` | Extract retained workspace scope/path owners and Canvas invocation type. |
| SAP-3091 2/3 ([#910](https://github.com/sapiom/sapiom-js/pull/910)) | `1a338947` | Remove server routes and graph composition; retain discovery/currentness/watch ownership. |
| SAP-3091 3/3 | `cab477b541b0485f22a4948075d2921ba1a3434c` | Delete the server engine/store/watchers/relationships/contracts and filter unsupported browser events. |

The last row is the exact source-deletion revision. Subsequent review fixes
have their own runtime revision and verification record below. A fresh production
source and clean-built `dist` search finds no remaining imports or callers of
the retired modules. Old route
and event strings remain only in negative test/smoke probes. The public
`@sapiom/agent` PackageInventory source and schema are unchanged from `main`.

## Retained verification gates

Record results on SAP-3090, SAP-3091 and parent SAP-3083 at the accepted stack
head. The table defines the observation scope; actual run results follow below.

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

## Review-fix verification — 2026-09-10

Runtime source revision: `5bfed981be12701e523e9096bdd0ab498aff0f20`, including
`main` at `8679d7457a8c4a1f40b2137da9e677de01b62a53`. The JSON record's
`reviewFixes` entry contains fresh build hashes and per-PR typecheck results.
These updates preserve the original reviewed commits and the seven PR
boundaries; the cumulative working branch still contains every layer.

- #892 uses main's complete partial auth mock to resolve the merge conflict.
  All 263 integration checks passed; that mock's four cases also passed on
  #892's own tree. Main's deliberate removal of the duplicate Claude review
  workflow is carried through the stack.
- #907 restores per-project manual pan and zoom across project/agent navigation.
  Saved views are scoped to the current signed-in UI lifetime; offscreen maps
  recover by fitting, and Fit continues following pane/layout changes. Browser
  coverage restores E3.3's project tabs across different agent bindings. Its
  changeset identifies the removed compatibility branch as internal cleanup.
- #908 restores `--text-faint`, `--font-mono` and `--type-meta`, with computed
  style assertions and before/after mock screenshots in light and dark themes.
  The stale mock failure comment is removed. The viewport and metadata tests
  failed on the original code, then passed with the fixes.
- #910 reconciles both retirement changesets to the final JSON 404 contract,
  including all unknown `/api` paths. Boot-token authentication remains required.

Harness and dependency builds, Harness typecheck/lint, terminology and
provider-copy checks passed. All **3,845 Harness unit/integration cases** passed
(two explicit skips), all **10 performance cases** passed, all **634 browser
cases** passed, and all **15 Canvas browser cases** passed. All seven isolated
PR heads passed server/browser typechecks; #907's own tree also passed all ten
viewport/project-altitude cases. The fresh build contains no retired graph files.

The first three-worker Harness run failed one archive-wiring case with an empty
turn list. The affected file passed unchanged **8/8**, and the full two-worker
rerun passed unchanged. The initial failure remains in the JSON record; no test
or admission guard was weakened.

The package hashes and smoke evidence below belong to the earlier deletion
revision. They are historical evidence, not a newly packaged review-fix artifact.
Signed macOS installer/upgrade validation remains the SAP-3086 release gate.

## Original cleanup evidence — 2026-09-09

Runtime revision: `cab477b541b0485f22a4948075d2921ba1a3434c`. The
[machine-readable verification record](./retirement-verification.json) includes
package/bundle hashes, counts, skips and initial failures. The subsequent
review-fix revision is recorded separately above.

- A clean Harness build followed by the root build, typecheck and lint passed.
  Terminology, provider-copy, PR-template/security checks and all 178 root script
  tests passed. The Node 24 VM's root test command still fails the unchanged
  `agent-core` unreadable-directory assertion; this is not a green root run.
- All **3,840 retained Harness unit/integration cases** passed (two explicit
  skips), and all **10 isolated performance cases** passed. Remaining packages
  passed separately: MCP 179 (three skips), CLI 73, desktop 205.
- The browser run passed **625/627**; two Chrome targets crashed in the template
  preference file. That entire file then passed **23/23**, without code changes.
  All **627** unique cases passed across the full run and scoped rerun. All
  **15 Canvas browser cases** passed. The current authority tests include
  omitted-catalog recovery, exact session tabs and negative legacy request/event
  probes; retained map layout, navigation, history, focus and mobile checks pass.
- Fresh Linux x64 packaging uses Harness **0.16.0**, desktop **0.4.6**, Electron
  **33.4.11**. The unpacked app passed **16** smoke checks (one Windows-only skip).
  The actual AppImage extract-and-run wrapper also passed **16** checks on its
  isolated run, using the identical artifact and unchanged smoke coverage.
  Both runs recorded old graph read/refresh/navigation counts **0/0/0**, direct
  removed-route responses **404/404/404**, and unchanged saved map/history.
- All **195** built Harness runtime/assets match the packaged files byte-for-byte
  (the builder intentionally excludes TypeScript declarations and source maps).
  The clean built and packaged trees contain no retired graph modules. Desktop
  packaging used copied dependencies; shared workspace native binaries retain
  their original hashes.

AppImage: `sapiom-0.4.6-x86_64.AppImage`

SHA-256: `e63fb39419b54edc828814a7195faca6814edfe99b1f7f6c675c89752a3293ad`.

### Preexisting session-scope race observed during validation

The first AppImage run passed the map and other checks but failed its initial
session creation with `409 PROJECT_SESSION_SCOPE_UNAVAILABLE`. Its catalog
shows a newly enrolled root becoming `missing` during the handoff from
`pendingProjectCwds` to `SessionManager.pendingCreates`. Concurrent scope
reconciliation can omit the root while bootstrap scheduling/claim is awaiting.
The admission guard then correctly refuses the stale identity. The source
paths and scope derivation are unchanged by server cleanup; removed graph
scopes supplied no protective lease. The race predates this work in
[`873dad63`](https://github.com/sapiom/sapiom-js/commit/873dad63928c287b35c37c5c401042d7ffa05149)
and the scheduling handoff in
[`21684912`](https://github.com/sapiom/sapiom-js/commit/21684912c20feaf1d86a84e5ab8199dc205f32cc).

The isolated AppImage rerun passed without changing the artifact or test. That
result does not fix the race. SAP-3091 records it as a separate functional
follow-up: retain scope continuously through enrollment, scheduling, claim and
transfer to pending creation, without allowing duplicate bootstrap sessions or
weakening final admission. A deterministic regression can hold the second
outbox `beforeSchedule` callback, complete a concurrent `/api/workflows` read,
then require one successful session with the same active identity. This seam
has been identified but not implemented or run in the cleanup.

## Historical SAP-3089 authority evidence — 2026-09-09

The server fence is commit `d3c91355`, based on main `65219660`. Browser code,
screenshots, and this record are reviewed together in the next stack layer.
This is the original authority-fence evidence, before the source-deletion
revisions above. Its temporary 410 responses and original test counts are not
the final cleanup result.

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
