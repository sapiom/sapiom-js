# Program Design: New-session file uploads

## Files

- `.changeset/new-session-file-uploads.md` — patch release note for `@sapiom/harness`.
- `packages/harness/src/shared/types.ts` — attachment directory, inline-size limit, and REST request/response contracts shared by server and SPA.
- `packages/harness/src/server/rest.ts` — boot-token-gated attachment materialization route, validation, safe filename generation, rate limiting, and session lookup.
- `packages/harness/src/server/rest.test.ts` — HTTP contract, size/error cases, path confinement, and proof that materialization never injects terminal input.
- `packages/harness/web/src/lib/api.ts` — real and mock attachment clients; mock call/failure instrumentation for Playwright.
- `packages/harness/web/src/lib/use-harness-state.ts` — stable attachment callback exposed to `App` through the existing harness state facade.
- `packages/harness/web/src/lib/new-session-attachments.ts` — queue model, file conversion, deduplication, materialization orchestration, and first-request formatting.
- `packages/harness/web/src/lib/new-session-attachments.test.ts` — fast tests for queue behavior, rollback-safe failure propagation, prompt composition, and POSIX/Windows paths.
- `packages/harness/web/src/components/NewSessionComposer.tsx` — scoped paste/drop/picker interactions, attachment tray, remove controls, progress state, and accessible announcements.
- `packages/harness/web/src/App.tsx` — derive the project name from text alone, keep the composer mounted during creation/materialization, close the provisional session on materialization failure, and register the complete held first prompt.
- `packages/harness/web/src/styles.css` — attachment tray, drag target, busy state, responsive wrapping, and focus/hover treatments using existing tokens.
- `packages/harness/web/e2e/new-session-composer.spec.ts` — user-path and regression tests for picker, drag, clipboard file, ordinary text paste, removal, attach-only start, delivery, and failure recovery.
- `docs/plans/new-session-file-uploads/*` — durable gate decisions, mockup, and slice status.

Explicitly unchanged implementation files:

- `packages/harness/web/src/components/Terminal.tsx`
- `packages/harness/web/src/lib/terminal-drop.ts`

Their existing tests still run as regression coverage.

## Types & signatures

```ts
export const HARNESS_UPLOADS_DIR = ".sapiom/uploads";
export const MAX_INLINE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_INLINE_ATTACHMENTS_TOTAL_BYTES = 50 * 1024 * 1024;

export interface AttachFileRequest {
  dataUrl: string;
  filename: string;
}

export interface AttachFileResponse {
  path: string;
  mediaType: string;
  bytes: number;
}
```

```ts
export type NewSessionAttachment =
  | {
      id: string;
      kind: "path";
      name: string;
      path: string;
    }
  | {
      id: string;
      kind: "inline";
      name: string;
      mediaType: string;
      bytes: number;
      dataUrl: string;
      fingerprint: string;
    };

export interface ResolvedNewSessionAttachment {
  name: string;
  path: string;
}

export interface QueueFilesResult {
  attachments: NewSessionAttachment[];
  errors: string[];
}

export async function filesToAttachments(
  files: readonly File[],
  pathForFile?: (file: File) => string,
): Promise<QueueFilesResult>;

export function mergeAttachments(
  current: readonly NewSessionAttachment[],
  incoming: readonly NewSessionAttachment[],
): NewSessionAttachment[];

export async function materializeAttachments(
  sessionId: string,
  attachments: readonly NewSessionAttachment[],
  upload: (
    sessionId: string,
    request: AttachFileRequest,
  ) => Promise<AttachFileResponse>,
): Promise<ResolvedNewSessionAttachment[]>;

export function buildIdeaWithAttachments(
  idea: string,
  attachments: readonly ResolvedNewSessionAttachment[],
): string | undefined;
```

```ts
interface HarnessApi {
  attachFile(
    id: string,
    request: AttachFileRequest,
  ): Promise<AttachFileResponse>;
}

interface NewSessionComposerProps {
  onSubmitIdea: (
    idea: string,
    harness: HarnessKind,
    attachments: readonly NewSessionAttachment[],
  ) => Promise<void>;
  onAttachmentError: (message: string) => void;
  // existing props unchanged
}
```

```ts
// App-local extension of the existing creation choke point.
interface CreateSessionAtOptions {
  keepComposerOpen?: boolean;
}

async function createSessionAt(
  cwd: string,
  harness: HarnessKind,
  options?: CreateSessionAtOptions,
): Promise<HarnessSession>;
```

Server route contract:

```text
POST /api/sessions/:id/attachments
AttachFileRequest -> AttachFileResponse
```

## Call stack

### Queue by paste, drag, or picker

1. Composer-scoped `paste`, `drop`, or file-input `change` handler receives browser `File` objects.
2. The paste handler exits without `preventDefault()` when there are no file items.
3. `filesToAttachments` tries the optional desktop `pathForFile` capability.
4. A real path becomes a zero-copy path entry; an unresolved file is read into a capped inline entry.
5. `mergeAttachments` deduplicates and preserves order.
6. `NewSessionComposer` renders the tray and announces the new count; errors go through the existing toast surface.

### Start the new session

1. `NewSessionComposer.submit` guards against duplicate submits and awaits `App.handleComposerSubmitIdea`.
2. `App` derives `cwd` from the original text only.
3. `createSessionAt(..., { keepComposerOpen: true })` creates/selects a provisional session while the composer and its queue remain mounted.
4. `materializeAttachments` passes path entries through and sends inline entries through `harness.attachFile`.
5. On success, `buildIdeaWithAttachments` appends one quoted path per attachment and `sendPromptWhenReady` registers the complete scaffold request.
6. `App` closes the composer; the existing readiness effect submits the request once the agent is ready.
7. On materialization failure, `App` closes the provisional session, leaves the composer/queue intact, surfaces the named error, and sends no prompt.

### Inline materialization

1. `RealApi.attachFile` POSTs the data URL and display filename with the boot token.
2. `createRestRouter` rate-limits, validates the request and live session, decodes/caps bytes, and derives a server-owned safe filename.
3. The route resolves `.sapiom/uploads/` within the session cwd, creates it, writes the bytes, and returns the absolute path.
4. The route never calls `SessionManager.submitInput`; first-request submission remains one operation owned by `App`.

## Test plan

### Fast unit tests

- `filesToAttachments uses a desktop path without reading or copying bytes`.
- `filesToAttachments falls back to inline bytes for a pathless clipboard image`.
- `filesToAttachments rejects an inline file over 10 MiB with its filename`.
- `mergeAttachments deduplicates repeated disk paths and repeated inline identities while preserving order`.
- `buildIdeaWithAttachments preserves user text and quotes POSIX paths with spaces`.
- `buildIdeaWithAttachments handles Windows drive paths/backslashes without corrupting them`.
- `buildIdeaWithAttachments supports attachments with no typed text`.
- `materializeAttachments preserves mixed path/inline order and propagates a named upload failure`.
- Existing `terminal-drop.test.ts` remains green unchanged.

### Server integration tests

- `POST attachment writes decoded bytes below the session cwd and returns the path`.
- `uses a server-owned filename even when the display filename contains traversal segments`.
- `accepts representative image, PDF, text, and generic binary media types`.
- `rejects malformed/empty base64, an oversized decoded payload, an unknown session, and a missing filename`.
- `rate limits a runaway attachment client`.
- `never calls submitInput while materializing a file`.

### Browser interaction tests

- Attachment button opens the hidden multi-file picker; selected filenames render with remove controls.
- Finder-style drag shows the drop state and queues every file.
- Clipboard image paste queues an inline file and prevents binary content entering the textarea.
- Copied file paste queues the file.
- Text-only paste edits the textarea and creates no attachment.
- Re-adding the same file does not duplicate it.
- Removing a file excludes it from the first request.
- Text plus mixed attachments reaches the mock agent in one first request and keeps the text-derived project slug.
- Attachments without text use the fallback project name and still reach the mock agent.
- Materialization failure leaves the composer and attachment queue intact and sends no partial prompt.
- Submit controls expose a busy state and prevent double session creation.
- Existing new-session and terminal-related browser tests remain green.

### Cross-platform and packaged verification

- Typecheck and build the harness plus desktop host.
- Run all harness unit/integration tests and the full Playwright mock suite.
- Exercise explicit POSIX and Windows path cases in fast tests.
- Package the macOS desktop app, run its smoke suite, then manually verify picker, Finder drag, pasted screenshot, ordinary text paste, removal, and first-request receipt with a real agent.
- Linux packaged smoke is covered by the harness PR workflow.
- Windows packaging/smoke is covered by the existing `windows-2022` desktop release matrix; report it as CI evidence, not local evidence.

## Design-system extension

### Existing patterns

- The attachment button reuses the composer's existing square ghost-control recipe beside the folder button.
- Attachment rows reuse raised-surface, hairline, tokenized text, and existing `Paperclip`/`X` icons.
- Errors use the current toast; no new feedback surface is introduced.

### States and accessibility

- Default: attachment button is keyboard focusable and labelled “Attach files”.
- Dragging: the composer border/drop overlay changes with existing brand and surface tokens; no layout shift.
- Queued: a labelled list exposes each filename and a per-file “Remove &lt;name&gt;” button.
- Busy: send, picker, removal, and repeat submission are disabled; an `aria-live` status reports attachment processing.
- Error: the tray remains intact and focus stays in the composer so the user can retry.
- Text paste: native textarea behavior is preserved because file handling does not cancel a file-free paste.

## Least confident decisions

1. Clipboard file representation differs by OS/application. The design handles both disk-backed and pathless `File` objects, but native pasted-screenshot proof is only possible on the OS being run; Windows/Linux native evidence must come from their packaged jobs or hands-on QA.
2. A 10 MiB cap applies only to clipboard-only bytes. It is intentionally aligned with the repo's former image composer and current 15 MiB JSON parser ceiling; path-backed Finder files remain zero-copy and uncapped.
3. Materialization happens after a provisional session exists because that safely scopes the write to an established cwd. Keeping the composer mounted and closing that provisional session on failure prevents a duplicate retry or a silently incomplete first prompt, at the cost of a little orchestration in `App`.
