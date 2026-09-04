# SAP-3152 cutover ledger

Recorded against predecessor
`ca747232e0b775b5be5c69c5427c778b3774dd4f`. This ledger uses the frozen
preflight snapshot; legacy pull requests were not queried again.

## Replacement stack

| Issue | PR | Exact head | Replacement evidence |
| --- | ---: | --- | --- |
| SAP-3148 | #804 | `5d00c55925d1907670bed6e885384b25eb775a73` | Neutral session principal, common prompt/tools, project-name map selection, ordinary tabs, durable bootstrap |
| SAP-3149 | #806 | `90eb569eb6b90b917c49128b6a23c7215a0843d6` | Canonical digests, immutable history, CAS/rebase/restore, migration, universal authoring |
| SAP-3150 | #807 | `acb2dbae6a3e533e01a065c43fa4109bdd82ca14` | Deterministic canonical/ad-hoc briefs, impact, bounded context projection |
| SAP-3151 | #808 | `ca747232e0b775b5be5c69c5427c778b3774dd4f` | Writable nested delegation, claims, reuse, kickoff acknowledgement, recovery, manual-session ownership |

SAP-3151 is frozen by explicit user direction. Its exact-head review confirmed
the prior bounded fixes and left one known cleanup-recovery finding. The user
directed the stack to move forward without another SAP-3151 change. This is a
recorded exception, not an approval claim; SAP-3152 does not modify that PR.

## Frozen legacy disposition

| PR | Frozen head | Relationship | Replacement | Retained in replacement | Removed behavior | Closure |
| ---: | --- | --- | --- | --- | --- | --- |
| #773 | `0f9e86bd386b8c1bcffa2ab105b7c0c0707fb46b` | independent draft | SAP-3148 / #804 | PR-body design history only | browser-only simulated concept surface | Pending gate; date unset |
| #783 | `044c2664a8ac8bc94433f684fa85030671e75e10` | sibling of #784 | SAP-3149 / #806 | canonical graph ordering, ancestry, integrity tests | approval materialization and user-message evidence | Pending gate; date unset |
| #784 | `48dc1c5cdf5507e14f74e5b9bccdb0a863c2c16d` | root of #785–#787 | SAP-3149 / #806 and SAP-3150 / #807 | plan/brief records, exact sources, CAS, store integrity | role-bearing authorship, submissions, eligibility permission | Pending gate; date unset |
| #785 | `9cf604dc26172310e393dd05fc9b8ee2c63f0243` | child of #784 | SAP-3149 / #806 | read/validate/apply/rebase, atomic IDs and replay | role-only assertions and conditional tool registration | Pending gate; date unset |
| #786 | `2de609c6c0da7435ff35bf7d046f3b3a5aed3658` | child of #785 | SAP-3150 / #807 | compiler, impact fingerprints, bounded projection | restricted-session naming and implementation gate | Pending gate; date unset |
| #787 | `e0ca5cc9fefe0b03893e1d6bfe95d61d07bc0210` | child of #786 | SAP-3151 / #808 | spawn claims, reuse, kickoff delivery/recovery | consent ceremony, read-only sessions, fixed fan-out and authority hierarchy | Pending gate; date unset |
| #791 | `b7384928a97f128d1bbcf62187550bbef3c874ca` | independent | SAP-3148 / #804 | readiness, retry, preemption and evidence discipline | special-session bootstrap and one-shot maintenance | Pending gate; date unset |

#783 and #784 share an old base but are not stacked. They exported conflicting
revision/digest concepts and computed different digest preimages. SAP-3149
reconstructed one vocabulary from the replacement base rather than merging
both and repairing them afterward.

No branch is to be deleted, rewritten, or merged for preservation. Closure is
permitted only after the SAP-3152 exact head has complete local evidence,
hosted checks, and exact-head autonomous review. Ownership-excluded pull
requests are outside this ledger, all API operations, and every completion
gate.

## Traceability commands

The following replacement tests passed together at the SAP-3152 checkpoint:

- #783: `agent-map-version.test.ts`, `agent-map-canonical.test.ts`, and
  `agent-map-codec.test.ts`;
- #784 and #785: `build-plan-service.test.ts`,
  `build-plan-canonicalization.test.ts`, `build-plan-codec.test.ts`, and the
  build-plan MCP cases in `agent-map.test.ts`;
- #786: `agent-brief-compiler.test.ts`, `agent-brief.test.ts`, and the focused
  context cases in `session-manager.test.ts`;
- #787: `subsession-coordinator.test.ts`,
  `subsession-coordinator-store.test.ts`, and
  `subsession-delegation.spec.ts`;
- #791: `project-bootstrap.test.ts`, `project-bootstrap-outbox.test.ts`,
  `project-bootstrap-outbox.test.ts` under the server suite, and the bootstrap
  cases in `agent-map-mcp-wiring.test.ts`.

The aggregate absence gate is `pnpm terminology:check`. It scans live code,
tests, browser journeys, docs, and changesets and fails when a retired literal
appears outside the exact migration allowlist or an allowlisted occurrence
count changes.

The closure comment for each row must link SAP-3147, SAP-3152, this PR (#811),
and the row's replacement PR; quote the frozen head; state that the branch and
review history remain available; summarize the retained and removed columns;
and set the actual UTC closure date here immediately after the remote action.

## Retained legacy strings

The terminology allowlist is the executable register. Retired literals are
limited to:

- the read-only E2 proposal-actor decoder and its exact migration tests;
- deployed E2 aggregate migration fixtures;
- pre-upgrade project-bootstrap and session-metadata migration fixtures;
- the isolated legacy bootstrap-state path resolver;
- the released `plannerOrigin` prompt-event key, decoded only to keep private
  bootstrap instructions out of upgraded session transcripts.

That prompt-event key is intentionally retained rather than included in the
dead-model deletion set. It affects transcript compatibility only and cannot
select identity, tools, prompts, sandbox policy, or implementation authority.

Each entry has an exact path, pattern, occurrence count, rationale, and stale
entry failure. `agent-map-legacy-migration.test.ts` also proves the decoder is
referenced only by aggregate migration and not by live proposal services.
