# SAP-3152 journey evidence

Evidence date: 2026-09-04 UTC. Replacement predecessor:
`ca747232e0b775b5be5c69c5427c778b3774dd4f`.

This record distinguishes automated proof from checks that require a hosted
or interactive desktop environment. It does not turn an unavailable manual
check into a pass.

## Automated journey matrix

| # | Journey | Evidence | Result |
| ---: | --- | --- | --- |
| 1 | One ordinary `Plan Agents` session and retry-safe bootstrap | `project-bootstrap-outbox.test.ts`, `project-bootstrap.test.ts`, `project-bootstrap-outbox.test.ts`, `agent-map-mcp-wiring.test.ts`; full Harness and browser suites | Pass for scheduling, retry, restart, preemption, one-session identity, and one accepted map update. A human real-model evidence-quality walk remains required. |
| 2 | Project name renders the map without creating or switching a session | `project-map-navigation.spec.ts` in the 501-test Chromium run | Pass |
| 3 | `Plan Agents` is an ordinary writable conversation/canvas tab | `project-map-navigation.spec.ts`, `session-tabs.spec.ts`, and MCP wiring tests | Pass |
| 4 | Clear implementation begins without a role/mode/confirmation gate | `direct-action-gating.test.ts`, `direct-actions.spec.ts`, `new-session-composer.spec.ts` | Pass |
| 5 | A manual session updates the shared map and plan | `agent-map.test.ts`, `agent-map-mcp-wiring.test.ts`, `build-plan-service.test.ts` | Pass |
| 6 | Concurrent plan writes conflict or explicitly rebase without loss | `agent-map-proposal-service.test.ts`, `build-plan-service.test.ts` | Pass |
| 7 | Canonical and ad hoc briefs focus context without changing tools | `agent-brief-compiler.test.ts`, `agent-brief-service.test.ts`, `focused-project-context.test.ts` | Pass |
| 8 | Delegation retry produces one child/process/kickoff/tab | `subsession-coordinator*.test.ts`, `subsession-delegation.spec.ts` | Pass |
| 9 | A delegated child can delegate with the same project capabilities | `subsession-coordinator.test.ts`, `agent-map-mcp-wiring.test.ts` | Pass |
| 10 | Spawn/kickoff restart boundaries reconcile durably | `subsession-coordinator-store.test.ts` and `subsession-coordinator.test.ts`, including uncertain-delivery and fresh-restart cases | Pass at the fault-injected storage/service layer. A real process-kill desktop walk remains required. |
| 11 | Reconciliation does not claim, kill, or release manual sessions | `subsession-coordinator.test.ts`, `subsession-delegation.spec.ts` | Pass for service/UI ownership. The preflight's byte-and-mtime snapshot variant was not added to the frozen SAP-3151 product PR. |
| 12 | Historical state is readable and restoration appends | `agent-map-version.test.ts`, `build-plan-service.test.ts`; both assert a new version, copied semantics, explicit `restoredFromVersionId`, immutable ancestry, and a new record digest | Pass |
| 13 | Existing Canvas/Steps and ordinary session creation remain intact | 501/501 web Playwright tests and 11/11 Canvas Playwright tests; no `.skip` or `.fixme` in either suite | Pass |

## Commands and exact results

| Command | Result |
| --- | --- |
| `pnpm build` | Pass |
| `pnpm typecheck` | Pass, including the Harness web TypeScript project |
| `pnpm lint` | Pass under the repository's existing lint boundary; SAP-3152 does not widen or change it |
| `pnpm --filter @sapiom/harness test` | Pass: 223 files, 3,577 tests; performance tier 3 files, 10 tests |
| Focused map/plan/brief/bootstrap/delegation Vitest command | Pass: 9 files, 117 tests |
| Explicit E1/E2-to-neutral migration Vitest command | Pass: 2 files, 20 tests |
| `pnpm --filter @sapiom/harness test:ui` | Pass: 501 Chromium tests |
| `pnpm --filter @sapiom/harness test:canvas` | Pass: 11 Chromium tests |
| examples, terminology, and provider-copy gates | Pass: terminology audited 913 files with no stale allowlist entries |
| Harness production build | Pass |
| Desktop distribution | AppImage created; `.deb` packaging then failed because this VM lacks `libcrypt.so.1` |
| Packaged AppImage smoke | Not runnable here: this VM has neither FUSE nor an X server/`xvfb-run`. The AppImage exists and extracts successfully. |
| `pnpm --filter @sapiom/harness e2e:live` | Partial: node-pty and the complete first server/session/ingest/canvas phase passed; the second phase failed an unchanged cached-API-key fixture assertion |
| `pnpm --filter @sapiom/harness sim:e2e` | Failed in an unchanged script: its ingest-router fixture omits the now-required `authenticate` dependency |

The two opt-in simulation failures do not touch SAP-3152 files and are
recorded as follow-up test-infrastructure drift, not hidden or repaired in this
audit/docs ticket.

## Dead-model and privacy audit

- No live prompt, tool-registration, sandbox, session-selection, or telemetry
  path branches on the retired project-agent roles.
- Retired literals occur only in explicit migration decoders/fixtures and are
  enforced by exact-path, exact-count terminology allowlist entries.
- The browser and server redaction tests cover prompt bodies, source text,
  local paths, credentials, connector content, provider errors, and focused
  brief prose. Lifecycle telemetry carries bounded enums, identifiers, counts,
  and digests rather than authored content.
- No web or Canvas spec is skipped or marked fixme.

## Manual/hosted completion items

Before final closure or stable rollout, attach:

1. a real-model first-project recording showing that seeded nodes are supported
   by available project evidence;
2. a packaged desktop walk of project-name map selection, ordinary tabs,
   direct implementation, retry-safe delegation, and a real process restart;
3. the hosted exact-head checks and exact-head autonomous SAP-3152 review;
4. the beta-first rollout drill described in `rollout-rollback.md`.

Until those items exist, the legacy-PR closure gate remains closed.
