# Retained Assistant history

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
