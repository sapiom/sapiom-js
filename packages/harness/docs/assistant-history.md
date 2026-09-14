# Retained Assistant history

`GET /api/sessions/assistant-history?cwd=<absolute-workspace>` returns
`{ entries: AssistantHistoryEntry[] }`, ordered by latest retained activity.
It requires the current boot token and workspace/Assistant authority. Entries
use Studio IDs, including sessions whose Terminal never started, and initially
report `nativeResume: "unchecked"`. Listing never launches or queries native
runtimes. Missing, partial and unreadable checkpoints have distinct states.
Account changes during listing discard the result. Malformed metadata returns
503 rather than silently substituting a different conversation.

`GET /api/sessions/:id/assistant/record` returns `{ record: AssistantRecord }`
for the currently authorized Studio session and Assistant binding. Supply the
current boot token in `X-Harness-Token`. The server checks current Assistant
eligibility and workspace authority before and after reading. Listing or reading
a retained record does not start OpenCode, create a conversation, or submit work.

| Status | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| 200    | The last successfully retained record, with `Cache-Control: no-store`.           |
| 400    | The Studio session ID is invalid.                                                |
| 401    | The boot token is missing or incorrect.                                          |
| 403    | Assistant access, workspace authority, or the binding is unavailable or changed. |
| 404    | This authorized binding has no retained record or native association.            |
| 503    | The record or its metadata could not be read or validated.                       |

The [record schema](../src/shared/assistant-record.ts) includes the exact Studio,
authority, workspace and native-conversation binding; a monotonic revision;
`capturedAt`; `reconstructed: true`; public turns/messages; original counts;
and explicit `limitations`. It is a bounded reconstruction, not native history,
a Resume credential, or a replay log. Available accepted-context references do
not contain their private instruction/source bodies.

Each serialized record is at most 64 KiB. Text fields retain at most 4,000
characters and tool input/output/error fields 512 each. Private reasoning and
instruction parts, attachment contents and unsupported parts are omitted or
marked. Size reduction can drop early turns or message content; counts can exceed
the retained excerpt. Incomplete turns and every omission/truncation remain
visible in the schema. A missing accepted-context reference does not prevent
reading otherwise available public history.

Capture runs under the host's existing observer independently of browser mounts.
Persisted message changes trigger at most one background capture start per second;
raw streamed text deltas do not trigger capture. Explicit acknowledgement,
lifecycle and idle checkpoints can flush immediately. Native reads are capped at
16 MiB and have a three-second timeout. Failure preserves the previous record,
so a successful GET can return an older `capturedAt`. Disposal and authority loss
cancel capture; opening a retained record never resumes execution.
# Selected native availability

Resume commits its operation UUID and exact saved-binding digest atomically with
the lifecycle header. The private proof is excluded from public state. An exact
retry can reconcile a lost acknowledgement; a later lifecycle revision, End or
changed binding invalidates it. A runtime restored after a crash revalidates
native history and original accepted context, then commits a paused lifecycle.
No runtime lease or saved system prompt is persisted in the operation proof.

Open an Assistant entry from Studio's existing session history to read its saved
messages and tool excerpts. Mixed Terminal and Assistant entries are grouped by
Studio session ID. Sessions that have never started a Terminal remain visible.
The pane labels reconstructed, shortened and incomplete content, supports Back,
and discards results after an account, project or navigation change. Viewing a
record starts no native runtime. Native availability and Resume are separate
explicit actions.

Native inspection is explicit and separate from metadata listing. It validates
the authorized saved Studio/native association, reads only that native session
and its bounded history, and checks the saved execution context through the
shared delivery preflight. Available public history can remain readable when
native history or required retained context is unavailable.

Inspection never creates an association, posts a prompt, or grants execution.
It holds a per-session admission slot, obeys End and shutdown, and retires only
its own provisional runtime. Existing running runtimes remain running. Startup
and reads have a deadline; uncertain provisional cleanup is reported explicitly.
