# Assistant background-session acceptance

Manual integration proof for SAP-3291, 2026-09-12. This exercises the combined SDK with PRs #950 and #951 and the SAP-3291 stack. It complements the committed observer, lifecycle, protocol, adapter and browser regressions.

## Setup

Real `startServer`, nonmock built Studio SPA, real browser boot authentication, `AssistantAccess`, durable credential refresh, `OpenCodeBridge`, `OpenCodeHost`, native observer, REST and event WebSocket. Two Studio sessions share one temporary folder and use distinct OpenCode state directories. Native version: 1.18.29.

The authority and model endpoints are controlled loopback HTTP fixtures with synthetic credentials and Responses output. Terminal adapters launch idle local Node processes. Native MCP and automatic title generation are disabled; native tool permissions deny everything except a prompted read of the temporary README. Disabling title generation makes model-call counts correspond to the tested turns. The actual native startup supervisor and ownership protection remain active.

This is a native/Studio integration check, not production OAuth, model quality, remote MCP, Electron packaging or a Mac-stack check.

## Verified behavior

- A streams while selected; switching to B removes A's browser stream while its one host observer remains.
- A completes while B waits on a real native read permission. The real summary socket reports A idle/current and removes its Working indicator without claiming task success. B's draft stays intact.
- Returning to A restores its complete answer once and retains its separate draft. The selected controller reports Finished using the native completion contract.
- B's permission is acknowledged through native while A is selected. The observer clears B's pending count and observes its continuation finish in the background.
- Review and new-session views unmount the selected display without stopping background work. Terminal/Assistant and A/B switches preserve separate in-memory drafts.
- During a controlled event-stream outage, all native SSE consumers are absent. A still completes and persists its answer. The host reconnects, becomes current and reports idle; the selected display subsequently restores the complete answer.
- Ending A's Terminal preserves its Assistant binding, completed history and unsent draft. The retained session remains accessible from history; a document reload restores the native messages. Unsent drafts intentionally remain memory-only.
- Exactly three intentional user prompts are persisted: two for A and one for B. Four main model calls occur: A twice, and B's tool call plus its continuation. No prompt is replayed by observation, reconnection or navigation.

The run records real `assistant.state` revisions, native event consumer counts, synthetic model requests, screenshots and a browser trace. The maximum observed consumers per runtime is two: one host observer and one selected display. Background sessions retain one observer. Shutdown verifies both native PIDs have exited, no event consumers remain, and temporary state is removed.

## Verification record

The final run passed at **2026-09-12 10:11:25–10:11:47 UTC** (22.65 seconds). Native `/global/health` confirmed both processes were version 1.18.29. Observation recovered 230 ms after restoring the event transport. All eleven behavioral/cleanup assertions passed, with no browser page errors or blocked external requests. Optional account-plan/template requests received controlled loopback 404 responses.

The combined checkout used main `76318848`, PR #950 `9b40f113`, PR #951 `eff8fe06`, and the SAP-3291 increments #955, #956, #958, #959, #960, #961, #962, #966, #967 plus this navigation change. The fixture disables telemetry, configures loopback authority/model destinations, and blocks nonloopback browser/server fetches. This does not audit every possible native-child network destination.

The complete fixture is retained with this workspace's SAP-3291 execution evidence. It imports the combined source, wraps only environment/credential discovery and native fixture configuration, and runs as one explicitly selected Vitest test. It does not mock host summaries or intercept the Studio state/WS/native browser routes.

The focused browser suites also cover malformed/older projections, authority clearing, unavailable/uncertain/input precedence, unknown summaries creating no tabs, Terminal-exited header/history rows and hovered-tooltip updates/removal. Earlier commits carry the stream/history/pending-read ordering regressions.
