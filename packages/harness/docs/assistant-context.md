# Assistant context contract

Studio owns workspace authorization and contextual instructions. OpenCode owns
the native conversation and execution. The internal Assistant uses a request
snapshot; `.sapiom/harness-context.json` remains a Terminal integration and must
not supply authoritative context to conversations sharing a directory.

## Snapshot and selection

`StudioAssistantContext` in `src/core/studio-assistant-context.ts` records:

- Schema version and a SHA-256 revision of the serialized snapshot.
- Studio session ID, canonical cwd, project identity and environment.
- Separate selected and bound agents, plus authorized workspace inventory.
- Capability availability and instruction provenance, revisions and load status.

The browser can submit a selected agent path as intent. The host validates it
against the authorized canonical cwd and registry; it does not accept arbitrary
system prompts, workspace overrides or capability claims. Definition IDs are
included only when the registry marks their cloud definition visible.

Selection is sampled at Send. `available`, `none`, `not-provided` and `unavailable`
are distinct states. Only an omitted selection falls back to the conversation's
binding. An explicit empty or deleted target never selects another agent.
Snapshot values are detached from mutable registries. A changed selection,
binding, source or capability changes the revision of the next request.

## Instructions and recovery

`composeAssistantPrompt(context)` is the single normal prompt composer.
It keeps `StudioAssistantResult/v2:<token>` first, then the versioned context
policy and snapshot. A Studio profile is mandatory. Required guidance without
available text or a managed source location fails before native dispatch.

The profile uses the active environment's served guidance with a bundled
fallback and records the actual source. Existing Terminal prompt fetching keeps
its string-returning API. The project role carries generic writable authoring
guidance without claiming that unconnected tools are available.

`recoverAssistantPrompt(savedSystem)` creates fresh completion bookkeeping and
preserves the admitted context verbatim. Native compaction controls are not new
user intent: recovery traces them back to the accepted user message. Old history
without a saved context stays readable, but cannot be automatically recovered
using invented current context.

## Loader boundary

The server resolver supplies authorized identity to sibling loaders, which return
`AssistantGuidance` records instead of writing a second native prompt:

- Project rules: source, scope, revision and text; deeper applicable rules win,
  with `AGENTS.md` preferred over a same-directory `CLAUDE.md` fallback.
- Managed skills: version, availability and a host-prepared location.
- Continue: one recorded brief for a new conversation, explicitly distinct from
  resumed native history. Recovery preserves an accepted brief without duplicating it.
- Capabilities: actual server connection/catalog facts, never a browser list.

Missing optional sources are explicit. Required missing sources block dispatch.
The foundation does not itself implement the project instruction loader, managed
skill materializer, queue transitions, Resume/Continue UI or complete tool parity.
Those integrations must preserve this contract and the existing access gate.

## Retained source artifacts

The source codec records the Studio policy, exact guidance bytes and explicit scope,
skill and MCP manifests. Content hashes preserve UTF-8 bytes, BOMs and line endings;
source revisions additionally include identity, provenance, applicability and fallback.
Candidates detach provider buffers and facts before asynchronous acceptance work.
The shared 4 MiB bound also caps aggregate retained material before copying it.

Complete supplied skill artifacts contain `SKILL.md` plus sorted resource members,
their exact bytes, hashes and executable flags. The codec rejects missing entrypoints,
invalid encodings, links, traversing or nonportable paths, case collisions and file/
directory conflicts. It does not collect or materialize a live skill directory.
Every accepted available source must have verified material, even when optional;
recorded absence remains explicit. Constructing a record does not commit it to disk
or prove native acceptance. Source acquisition and generation refresh remain separate.

## Durable acceptance

Accepted records and exact source objects live under the private host state root at
`assistant-context/v1/<authorityScope>`, outside the native engine. A synced immutable
manifest is published last, after every available source is verified and retained.
Repeating an identical acceptance is idempotent; conflicting content is rejected.
Reads verify the conversation, authority, record digest and every source hash, with
bounded allocations and symlink rejection. Errors never fall back to live providers.

Cancellation or storage failure acknowledges no retention and authorizes no dispatch.
An interrupted write can leave unreferenced objects, or an unacknowledged manifest
after a directory-sync failure. Retention alone never proves native acceptance.
Directory fsync is required: unsupported platforms fail closed instead of claiming
durability. Linux filesystem behavior is covered by the storage tests; other platforms
require their own verification. Host shutdown preserves this repository for recovery.

## Accepted context coordination

`createAssistantContextDelivery` is the shared acceptance, composition and recovery
service. Acceptance resolves one detached candidate and commits all retained material
before returning an identity. Composition reads that exact accepted record, checks
the injected runtime-generation readiness boundary, and serializes a validated saved
system with an explicit attempt UUID. Recovery reads the original record; it never
resolves the current selection or fetches new guidance. An available accepted source
remains mandatory on readback even when its original provider marked it optional.

The host exposes an immutable, secret-free `contextAuthorityScope` and selected model.
The scope includes user, tenant, environment name, canonical API URL, canonical cwd
and Studio session. Credential rotation and runtime restart preserve it.
`assertCurrent` separately checks exact hosted-object ownership and fresh grants and
workspace access after asynchronous work. A retained manifest grants no authority.

Valid legacy inline context/v1 recovery preserves the exact saved suffix and creates
only a new attempt token. Context-free, malformed, foreign-workspace or location-only
legacy work fails clearly. The coordinator owns no dispatch lock or native request;
the existing admission and recovery owners are connected in the activation increment.
Runtime readiness is a required injected contract, not a claim that package-generation
acquisition or refresh is implemented by this service.

## Retained provider boundary

`createAssistantContextCandidateResolver` adapts the existing authorized selection,
profile and capability resolution into retained source materials. Its optional
guidance loader returns `{ metadata, version, material }`; mutable locations cannot
stand in for complete packages. The default project/skill sources still explicitly
record that their loaders are not connected. Real acquisition belongs to those loaders.

Admission cancellation reaches profile overrides/fetch, workflow/capability discovery
and guidance providers. Caller cancellation propagates; ordinary network/empty-profile
failures retain the bundled offline policy and explicit fallback provenance. A fallback
and an intentionally bundled profile can share exact content while having different
source revisions. Legacy inline records can carry that optional, validated provenance.

`assertAssistantRuntimeReady` currently supports verified retained text and catalogs.
It rejects accepted skill packages until a runtime can prove their managed generation
is materialized, including packages originally marked optional. Existing host startup
skill containment remains in force. This boundary does not implement generation
acquisition, refresh or lifecycle retention.
