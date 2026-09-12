# Studio context lifecycle and reuse assessment

Decision record for [SAP-3399](https://linear.app/sapiom/issue/SAP-3399), **2026-09-12**.
The accepted SAP-3327 context and SAP-3287 interaction contracts remain in force.
This assessment selects implementation interfaces and supplies fresh native/gateway evidence;
the downstream loaders and session controls still own their implementation and acceptance tests.

## Inputs and evidence

[Ewan's original POC](https://github.com/sapiom/sapiom-js/blob/f8f4da8ac920e7e32e51e0796a805a6a53e1f339/packages/opencode/README.md)
supplied native runtime/MCP/model/process integration and explicitly identified the missing Studio instruction path.
The [native probe guide](context-probe.md) records exact main, #950/#951/#952/#953, integration tree,
OpenCode **1.18.29**, and adapter **0.2.22** revisions and reproduction instructions.
The issue's sanitized evidence bundle contains full controlled-provider requests/history, real gateway
usage receipts, source/deployment provenance, the integration patch, and a checksum manifest.

All 16 inspected native source files match upstream commit
[`16747470f976aca3d362ad730bcd3fe82ecc2c9a`](https://github.com/anomalyco/opencode/tree/16747470f976aca3d362ad730bcd3fe82ecc2c9a).
Source paths below are relative to its `packages/opencode/src/` unless prefixed with `SDK`.
Native probes passed **24 checks / 14 model requests**, on both main's fixture envelope and the actual draft
composer. The combined candidate passed **37 focused harness tests**; projection has **3 focused tests**.
Another **3 focused tests** reject incomplete source/provider observations while accepting unavailable cache fields.
This does not replace final browser/session-control parity acceptance.

## Capability map

| Capability             | Owner / verified behavior                                                                                                                              | Evidence or remaining boundary                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt assembly        | Native prepends provider/agent, environment, native instructions, MCP instructions, skill catalog, then current `user.system`; native history follows. | `session/prompt.ts:1255`, `session/llm/request.ts:58`; actual initial/follow-up/changed/continuation requests captured.                |
| Root discovery         | Studio isolates HOME/XDG/config and disables project/Claude/external discovery.                                                                        | SDK `packages/opencode/src/server.ts`; root AGENTS and CLAUDE canaries absent in native probe.                                         |
| Nested rules           | Native file reads independently discover adjacent rules despite that flag.                                                                             | `session/instruction.ts:179`, `tool/read.ts:300,355`; nested canary appears through real `read`. Must close this path.                 |
| Explicit instructions  | Native rereads configured files and fetches configured URLs on every model step.                                                                       | `session/instruction.ts:155`; changed explicit fixture V2 appears in the same turn. URL behavior source-verified.                      |
| Skill catalog/body     | Native instance caches discovered SKILL.md content; catalog goes in system, body appears on invocation.                                                | `skill/index.ts:105,259,294`, `session/system.ts:105`, `tool/skill.ts:23`; fixture still loads V1 after file becomes V2.               |
| Skill resources        | Support file names/content can be read live; body caching does not freeze a package.                                                                   | `tool/skill.ts:46`; immutable package/generation transition remains downstream verification.                                           |
| MCP instructions/tools | Native caches initialize instructions/catalog; reconnect and `tools/list_changed` can update them.                                                     | `mcp/index.ts:390,461,571,666`; fixture instructions and successful ping verified; live refresh boundary remains downstream.           |
| Code-mode catalog      | Studio enables code mode; MCP tools are described inside `execute` rather than each becoming a top-level provider function.                            | `session/tools.ts:388`, `tool/registry.ts:280`, `tool/code-mode.ts:199`; captured tools include the ping catalog and actual execution. |
| History/compaction     | Native stores history, summarizes/prunes, and generates synthetic continuation. Studio's existing messages hook restores its accepted system.          | `session/compaction.ts:271,319,468,519`; real compaction, accepted context, restart IDs and saved systems verified.                    |
| Request projection     | Supported `experimental.chat.system.transform` changes privileged wire text without rewriting history.                                                 | `session/llm/request.ts:69`; test hook passes native continuation and exact-token checks. Production hook remains SAP-3328.            |
| Provider reuse         | Native OpenAI provider supplies session `prompt_cache_key`; actual bridge preserves it.                                                                | `provider/transform.ts:1310`; real Responses cache fields and one continuation hit observed below. No hit-rate guarantee.              |

## Source ownership and refresh matrix

**Acquisition** obtains/version-checks authoritative bytes. **Assembly** includes already accepted bytes in a
model request. **Provider caching** is independently reported input processing. Retained history does not
remove instructions from later model input.

At Send, capture browser selection intent. Before acknowledging accepted/queued work, the host validates
intent and records immutable source references. Dispatch never silently resolves a newer source set.

| Source                   | Authority / revision                                                                                                                          | Acquisition and change detection                                                                                                                                                                       | Later acceptance / accepted work                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio profile           | Host environment endpoint or authorized bundled fallback; source identity + hash of actual accepted text + provenance.                        | Shared HTTP provider uses freshness/validators; cache key includes authority/environment/config. Hash bodies when validators do not avoid transfer.                                                    | Updated bytes apply on later acceptance. Recovery uses retained bytes and recorded fallback, never a current fetch.                                         |
| Project rules            | Host canonical workspace/scope; AGENTS with same-scope CLAUDE fallback, deeper applicable scopes winning; body and discovery-manifest hashes. | SAP-3329 discovers through the shared source provider. Add/edit/delete/rename and precedence changes invalidate future acquisition. Freeze the applicable scope manifest, including absence decisions. | Later lazy scope access selects from the accepted manifest. Newly created/edited files cannot silently become authoritative instructions for existing work. |
| Skill catalog            | Host-managed package identity and manifest of name/description/location/permission facts.                                                     | Materialize new immutable version directories; prepare a matching native instance generation at an idle dispatch boundary.                                                                             | Accepted work retains its catalog generation; never reinterpret an old skill name against newly installed content.                                          |
| Skill body/resources     | Accepted package includes SKILL.md and referenced instruction/resource/script tree.                                                           | Native body can load on demand; all managed relative paths resolve within the retained package version.                                                                                                | Missing/corrupt required retained content fails explicitly. Track invoked skill/version separately from catalog visibility.                                 |
| MCP instructions/catalog | Host-authorized endpoint; connection/catalog generation and instruction/definition hashes, without secrets.                                   | Observe reconnect/notifications. Stage changed instructional content and additions/schema replacements for later acceptance.                                                                           | Connector generation handling must preserve accepted capability intent, including code-mode execution. Disconnection/revocation takes effect immediately.   |
| Selected/bound agent     | Host-validated selection-at-Send and independently captured conversation binding/inventory; context digest.                                   | Resolve at acceptance; rail/binding/registry changes invalidate future context. Empty/deleted selection never silently picks another agent.                                                            | Same accepted facts for queue/recovery/continuation. A new message in a resumed conversation can acquire new intent.                                        |
| Capability availability  | Accepted discovery facts/catalog revision; current grants and execution checks remain independent.                                            | Refresh facts at acceptance, observe transport loss and revocation throughout execution.                                                                                                               | Immutability does not extend authorization or make an unavailable connector usable. Preserve the host model pin in normal/recovery requests.                |
| Completion metadata      | Host per-attempt token plus accepted-context reference.                                                                                       | New work creates bookkeeping; recovery rotates attempt token while retaining accepted context.                                                                                                         | Native ordinary/compaction continuation keeps the active token. Read old leading-v2 history and preserve one-dispatch fences.                               |
| Continue brief           | Host-recorded immutable brief ID/hash and source-conversation association.                                                                    | Capture once when recorded Continue creates a new native conversation.                                                                                                                                 | Include once and retain on recovery/compaction. Native Resume uses saved history; it does not synthesize a brief.                                           |

The workspace itself remains live task data. Reading/editing AGENTS.md as a requested file operation must
still work; those observed bytes do not replace accepted authoritative instructions during that task.

### Concrete acquisition policy

The public profile endpoint returned 7,164 UTF-8 bytes, release `1.3`, and full-body SHA-256
`8af78d184e5c06d813ef52f6cc0349411ce341173c1db485435ce077597ee99e`.
It advertises `Cache-Control: public, max-age=300`; a conditional weak-ETag request still returned 200/full body.
Its shorter content stamp hashes unstamped content and its release label is not a unique/orderable revision.

SAP-3400 should reuse the current accepted profile candidate within the endpoint's freshness window,
bounded at 300 seconds; missing/invalid freshness means revalidate at acceptance. Explicit invalidation,
environment/config changes and forced refresh bypass freshness for future acquisition. Use validators
when supported, otherwise compare acquired content hashes. Concurrent checks share one acquisition;
an unchanged result reuses the immutable version. Preserve fetch-disabled configuration and the existing
authorized bundled fallback, recording which content was actually accepted. Source expiry never edits
already accepted work. Filesystem events invalidate candidates; authoritative reads/hashes establish new versions.

### Required native discovery correction

SAP-3328 must close native uncontrolled nested-rule injection before claiming immutable rule delivery.
Select the narrow native guard in `Instruction.resolve`: `if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return []`.
Ship/pin a runtime artifact containing it, or verify an upstream version with equivalent behavior.
Editing wrapper TypeScript cannot patch the installed compiled native binary.

The alternative `tool.execute.after` exposes rendered output and loaded paths, without structured instruction
spans. Do not strip reminders with a loose regex: it can remove literal file content. The native guard leaves
direct reads and explicit host instructions intact and preserves native discovery when the flag is off.
Test flag on/off, root/nested AGENTS/CLAUDE/CONTEXT, direct rule-file reads, literal reminder text, and
mid-turn changes with an accepted host snapshot. SAP-3329 separately proves host precedence/discovery.
This is an integration prerequisite, not a product-contract change or an already delivered patch.

## Selected delivery interface

Preserve the durable leading-v2 envelope used by `composeAssistantPrompt`, saved history parsing, and
`recoverAssistantPrompt`. Project only its validated Studio portion through `experimental.chat.system.transform`:

```text
unchanged privileged native prefix (including native MCP/skill content)
deterministically ordered Studio policy and stable profile/rule guidance
stable source/catalog manifest where applicable
current completion token and existing completion contract
small accepted session/selection/binding/capability/source-reference suffix
unchanged native conversation history and user parts
unchanged provider tools / code-mode catalog
```

Do not repeat guidance bodies in both the stable block and dynamic JSON. Exclude random attempt tokens,
aggregate turn digests, selection, and transient timestamps from the stable block. Scope selection may change
the layout, but instruction content must still come from accepted sources. Keep trusted instructions privileged.

The fixture confirms that native retains the original system array: mutate it with `splice`, never assign
a replacement `output.system`. Compose into the host-managed credential plugin, preserving completion and
credential hooks; arbitrary caller plugins are overwritten by the wrapper. The existing compaction messages
hook runs before system projection. It supplies accepted content to synthetic continuation without rereading loaders.

#951's bridge reads the last line-start completion marker in trusted system/developer text. Keep the real
completion block after raw guidance and JSON-escape later dynamic data; guidance cannot introduce a later marker.
Production integration must strictly validate the authoritative host envelope, fail on malformed required context,
preserve legacy history behavior, and prove spoof/wrong-token rejection and compaction on the real bridge.

Native environment (including date), MCP/skill content, and current-turn system text all precede history.
Moving stable guidance earlier improves its possible reusable prefix; changing completion metadata still
precedes history. This does not establish full-history or cross-session reuse.

Extend existing `AssistantGuidance`, resolver/composer, and `prepareSkills` seams using this contract
(names below are proposed interfaces, not current exports):

```ts
type SourceVersion = {
  id: string;
  kind: "profile" | "project" | "skill" | "mcp" | "continuation";
  authorityScope: string; // opaque environment/workspace/host boundary
  source: string;
  scope?: string;
  revision: string;
  required: boolean;
  status: "available" | "unavailable" | "not-configured";
  contentRef?: string; // retained immutable bytes/package, never a mutable alias
};
type InstructionSet = {
  revision: string;
  sources: readonly SourceVersion[];
  scopeManifestRevision: string;
  skillCatalogRevision: string;
  mcpInstructionRevision: string;
  mcpCatalogRevision: string;
};
type AcceptedAssistantContext = {
  acceptanceId: string;
  context: StudioAssistantContext;
  instructionSet: InstructionSet;
  continueBriefRef?: string;
};
interface AssistantSources {
  acquireCurrent(
    authority: HostAuthority,
    reason: "startup" | "accept",
  ): Promise<InstructionSet>;
  retain(set: InstructionSet): Promise<void>;
  readAccepted(source: SourceVersion): Promise<ReadonlySourceContent>;
  invalidate(sourceId: string): void; // affects future acquisition only
}
interface AssistantContextDelivery {
  accept(
    hosted: HostedOpenCode,
    selectionIntent: string | null | undefined,
  ): Promise<AcceptedAssistantContext>;
  prepareRuntime(
    hosted: HostedOpenCode,
    accepted: AcceptedAssistantContext,
  ): Promise<ReadySourceGeneration>; // idle boundary, same native session/state
  compose(
    accepted: AcceptedAssistantContext,
    attempt: AttemptMetadata,
  ): NativePromptWithLegacyEnvelope;
  recover(
    savedNativeSystem: string,
    currentAuthority: HostAuthority,
  ): NativePromptWithLegacyEnvelope;
  projectNativeSystem(
    nativeSystem: string,
    active: ValidatedAcceptedEnvelope,
  ): string;
}
```

Source stores retain instruction packages/briefs and references, not a second transcript. Cache identity
includes authorization scope as well as content; byte equality does not bypass permission checks. Retain
versions while any accepted work/history can reference them. Missing required retained content fails with
context-unavailable; never substitute latest content. Garbage collection must respect recovery/Resume references.

Managed skill refresh must prove that native instance generation matches dispatch while keeping native
session/history. Native MCP notifications require an adapter/generation boundary for both instructions and
code-mode catalog execution. Do not use `prompt.tools` casually as an allowlist: native persists it into
`session.permission`, while current Studio recovery rejects nonempty session permissions.

## Transition rules

| Transition                   | Required behavior                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup                      | Validate authority, isolate runtime, prepare source generation. Prewarming may reuse content but does not accept a task.                                                         |
| Accept / queue               | Capture intent at Send; resolve/detach sources once before acknowledgement. Persist references with native-compatible completion metadata.                                       |
| Guidance changes during work | Invalidate future acquisition. Active work keeps accepted instructions/resources; current data remains readable. Apply revocation immediately.                                   |
| Queued dispatch              | Revalidate current grant and runtime readiness against saved sources; dispatch original intent/content.                                                                          |
| Recovery                     | Keep accepted sources/selection/brief and native results, rotate attempt token, retain one-dispatch fence and `hosted.model`. Never replay completed effects to rebuild context. |
| Resume                       | Attach real native history. Incomplete accepted work keeps its sources; new messages acquire current sources. Runtime recreation does not create a conversation.                 |
| Recorded Continue            | New native conversation with one immutable brief and a newly accepted current source set. This is not restoration of native history.                                             |
| Compaction                   | Native owns summarization/pruning. Preserve accepted-source references/completion metadata through supported hooks and restore retained content.                                 |

## Gateway baseline

Use the Luna/context integration checkout, built workspace dependencies, and a signed-in production API key:

```sh
SAPIOM_CONTEXT_GATEWAY_PROBE=1 SAPIOM_TELEMETRY_DISABLED=1 \
  packages/harness/node_modules/.bin/tsx /path/to/scripts/assistant-context-gateway.mjs \
  /path/to/integration-sdk /tmp/context-gateway.json
```

This paid opt-in script never runs in CI. It uses the actual native runtime, SDK credential bridge,
host model pin, live profile, and `https://router.sapiom.ai/v1/responses`. Studio eligibility and the empty
MCP server are fixtures: the stored browser JWT had expired, so this is not browser sign-in/eligibility acceptance.
Real gateway authentication uses the signed-in API key. Receipts contain counts/hashes/usage, no credentials or model prose.

Observed router deployment: `3259d34c5e76fb6344c2a64b669b4c4f8310bce2`; its `llm-gateway-py/` tree
matches inspected Sapiom main `ca8cbc224ffc3bc82c2b23b43195b8c5b56c2a11`.
Requested alias `gpt-luna`, low reasoning, `store: false`; actual served model/tier are recorded per response.
The body cache key stays fixed within one native conversation. The current bridge does not forward
`x-session-id`; the experiment does not add routing affinity or change gateway policy.

Native Responses SSE preserves actual terminal usage. Wire `input_tokens` includes reads/writes;
`inputMinusCacheReads` includes cache writes. Gateway internal decision records instead subtract both
cache reads and writes and default missing fields to zero. Keep raw field presence: absent measurements are
null/unavailable, not inferred misses. Ewan's older Fireworks/DeepInfra Chat usage patch is historical context;
do not add Chat `stream_options` to this Responses route.

Final run completed **2026-09-12 09:08 UTC**: 11 provider attempts across 9 scenarios, all HTTP 200 /
`completed`, served `gpt-5.6-luna`, tier `default`. One bridge retry is included separately:

| Scenario / attempt        | Input | Cache read | Cache write | First text ms | Total ms |
| ------------------------- | ----: | ---------: | ----------: | ------------: | -------: |
| cold                      |  8731 |          0 |        8728 |          1533 |     1977 |
| followup-1                |  8802 |          0 |        8799 |          3082 |     3200 |
| followup-2 / 1            |  8894 |          0 |        8891 |          1335 |     1735 |
| followup-2 / 2            |  8894 |       8891 |           0 |          1175 |     1987 |
| selection-change          |  8966 |          0 |        8963 |          1978 |     2076 |
| projected-1               |  9009 |          0 |        9006 |          1492 |     1631 |
| projected-2               |  9099 |          0 |        9096 |          1269 |     1527 |
| projected-3               |  9184 |          0 |        9181 |          1387 |     1529 |
| recovery                  |  9265 |          0 |        9262 |          1704 |     2035 |
| compaction / summary      |   957 |          0 |           0 |          1493 |     3081 |
| compaction / continuation |  8829 |       8625 |         201 |          4498 |     4591 |

The unchanged served profile was fetched **7 times / 50,148 bytes**; each response was 7,164 bytes with
the same hash. First acquisition took 379 ms, subsequent acquisitions 86–89 ms. Recovery and compaction
made no profile fetch. This establishes a concrete source-reuse opportunity independent of provider caching.

Normal follow-ups shared 10,338 system characters before the fresh completion token differed. With the
projection, that prefix grew to 19,616 characters; guidance began at offset 12,441 and completion at 19,591.
These are UTF-16 string character offsets, not token counts or the provider's complete serialization order.
The native prefix, tools digest and session cache-key digest stayed stable across ordinary requests.

Ordinary new turns reported zero cache reads both before and after projection. An identical-body retry
reported 8,891 cached tokens, and the projected native continuation reported 8,625. This demonstrates
available cache reporting/reuse on the route, without proving that the layout change caused either hit.
The reason ordinary turns missed remains unverified. The earlier complete run similarly missed on ordinary
turns and hit on continuation (8,628 of 9,074 input tokens); receipts retain both runs. No latency improvement
or cache-hit guarantee follows from this small sequential sample. Gate implementation on source/layout
correctness and report actual cache/latency distributions in SAP-3401.

## Downstream acceptance handoff

| Issue               | Ownership and measurable acceptance                                                                                                                                                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAP-3328            | Integrate validated privileged projection, legacy v2 compatibility, required-source failure handling, and native nested-discovery control on the reconciled #950–953 baseline. Prove exact completion, preserved history and compaction with actual native requests.                                                        |
| SAP-3400            | Implement source detection/acquisition reuse and dispatch-ready generations. Unchanged acceptance within freshness reuses bytes without another source fetch/read; expiry checks report actual transfers. Detected updates change later accepted revisions while active/queued/recovered work retains old versions.         |
| SAP-3329 / SAP-3330 | Real rule discovery/precedence and immutable managed-skill providers implementing the shared source contract; test additions/deletions/scopes, body/resources, and generation retention.                                                                                                                                    |
| SAP-3331            | Queue/recovery/Resume/Continue/compaction consume accepted versions with retained source lifetime and current grants. Test rail/source changes after acceptance and between queue/dispatch; include Epic 1 session controls.                                                                                                |
| SAP-3401            | Compare acquisition, request assembly, and actual provider cache processing independently. Capture all retries, same/different source revisions, unchanged/changed selections, recovery and compaction on the supported route. Report measured deltas and unavailable fields; do not set invented hit-rate/latency targets. |

Use common evidence fields: exact SDK/native/adapter/gateway candidate, requested/served model, opaque native
session/acceptance/attempt IDs and continuation relationships, context/instruction/catalog revisions,
per-source fetch/read counts/bytes/time/reuse/fallback, ordered block hashes/bytes/common-prefix units,
cache-key presence/digest, raw terminal usage/cache fields, HTTP/native outcome and headers/first-text/total time.
Instruction correctness and source immutability are required even where a provider returns zero cache reads.
Each implementation owns focused tests; SAP-3401 and final SAP-3332 parity cannot substitute for them.
