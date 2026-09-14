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
against the active canonical roots of its server-owned project and registry.
It does not accept arbitrary system prompts, workspace overrides or capability claims. Definition IDs are
included only when the registry marks their cloud definition visible.
Sibling roots share project context while the native process keeps its original
cwd. Missing roots, escaping aliases, and changed session/project authority fail
validation. Agent Map sends an explicit empty agent selection.

Selection is sampled at Send. `available`, `none`, `not-provided` and `unavailable`
are distinct states. Only an omitted selection falls back to the conversation's
binding. An explicit empty or deleted target never selects another agent.
Snapshot values are detached from mutable registries. A changed selection,
binding, source or capability changes the revision of the next request.
Composition validates the serialized schema and revision before dispatch. Mutating
a resolved snapshot requires resolving a new snapshot with its own revision.

## Instructions and recovery

`composeAssistantPrompt(context)` is the single normal prompt composer.
It keeps `StudioAssistantResult/v2:<token>` first, then the versioned context
policy and snapshot. A Studio profile is mandatory. Available profiles, project
rules and continuation briefs require text; managed skills may supply a location.
Required unavailable guidance fails before native dispatch.

The profile uses the active environment's served guidance with a bundled
fallback and records the actual source. Existing Terminal prompt fetching keeps
its string-returning API. The project role carries generic writable authoring
guidance without claiming that unconnected tools are available.

`recoverAssistantPrompt(savedSystem)` creates fresh completion bookkeeping and
preserves the admitted context verbatim. Native compaction controls are not new
user intent: recovery traces them back to the accepted user message. Old history
without a saved context stays readable, but cannot be automatically recovered
using invented current context.
Recovery verifies the UUID, exact completion/context policy, JSON schema and
revision. Truncated, changed or malformed saved prompts fail explicitly.

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
