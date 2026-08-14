# Architecture: New-session file uploads

## Fit

- `NewSessionComposer` owns a temporary attachment queue, picker, composer-scoped clipboard listener, drag state, removal controls, and accessible announcements. The listener is attached to the create-new composer rather than `window`, so it cannot intercept a live terminal paste. Ordinary clipboard text is ignored by attachment handling and continues into the textarea normally.
- Queue entries use two sources:
  - `path`: a dropped, picked, or copied file that Electron can resolve to an existing absolute path through the current desktop bridge.
  - `inline`: a clipboard `File` with no path (most importantly a pasted screenshot), retained in renderer memory until the session exists.
- This split follows Electron's contract: `webUtils.getPathForFile` returns an empty string for a JavaScript-created `File` that is not backed by a file on disk. Path-backed files therefore stay zero-copy, while clipboard-only bytes take a bounded fallback route.
- A small pure attachment module normalizes/deduplicates queue entries and formats resolved paths as first-request context. It shares the existing terminal path-quoting rule instead of defining a second escaping format.
- `App` continues to own session creation. It uses only the user's text to choose the project name, creates the session, materializes any inline attachments, and then passes the complete text-plus-file request through the existing held-first-prompt path.
- The existing live-terminal drag/drop and copy/paste behavior remains untouched; `Terminal.tsx` and `terminal-drop.ts` are not part of this feature's implementation surface.

## Endpoints

- `POST /api/sessions/:id/attachments` — accepts one base64 data URL plus a display filename for a clipboard-only file, writes it under the session's `.sapiom/uploads/` directory, and returns its absolute path without injecting terminal input.

The endpoint is behind the existing boot-token middleware. It validates the session, payload shape, decoded size, media type syntax, and filename; generates the stored filename server-side; confines writes to the session working directory; and uses a per-client rate limit. A single inline attachment is capped at 10 MiB and the renderer caps one new session's aggregate inline queue at 50 MiB. Path-backed desktop files do not traverse this endpoint and have no Studio-imposed size limit.

## Data

No database or settings changes.

Renderer-only queue entries:

- Path-backed: display name + absolute path.
- Clipboard-only: display name + media type + byte size + data URL + SHA-256 content fingerprint for deduplication.

Clipboard-only files are written to `.sapiom/uploads/` inside the new project after session creation. That directory is already covered by the scaffold's `.sapiom/` ignore rule. Queue state is discarded when an item is removed or the completed create flow leaves the composer.

Primary operations:

- Inspect only file-bearing clipboard items; never intercept a text-only paste.
- Prefer a bridge-resolved local path.
- Fall back to reading unresolved clipboard files into bounded inline entries.
- Reject unreadable or oversized inline entries with user-visible feedback.
- Deduplicate while preserving user order.
- Materialize inline entries and combine all resulting paths into one first request.

## Flow

1. The user pastes a file/image while the composer is focused, drops files over the composer, or chooses files with the attachment button.
2. `NewSessionComposer` checks each `File` with the existing desktop bridge.
3. Path-backed files queue by absolute path. Unresolved clipboard files are read into the bounded inline form. Selected files appear in one removable tray.
4. The user starts the session with text, files, or both.
5. `App` derives the project folder from the user's text only and creates the session.
6. `App` sends each inline entry to the attachment endpoint and replaces it with the returned project-local path. If any materialization fails, it does not send an incomplete first request and surfaces the named failure.
7. `App` formats the user's text plus every resolved path and registers that complete request with the existing readiness hold.
8. Once Claude Code or Codex is ready, the existing bracketed-paste submission delivers the request as one turn.

## External

No third-party APIs, environment variables, storage services, permissions, or new Electron IPC channels. The existing `pathForFile` bridge is reused; clipboard-only bytes travel only to Studio's boot-token-protected local server.

## Portability

- The renderer uses standard `File`, `DataTransfer`, and `ClipboardEvent` APIs already provided by Electron's Chromium runtime on macOS, Windows, and Linux.
- The desktop bridge uses Electron's cross-platform `webUtils.getPathForFile` implementation.
- Server writes use Node path utilities and byte APIs, never shell commands or hand-built separators.
- Existing quoting covers POSIX paths, Windows drive paths, spaces, quotes, and backslashes.
- Native macOS behavior is verified locally. Shared browser/server tests exercise platform-neutral behavior and explicit POSIX/Windows paths; packaged Linux and Windows evidence comes from the repository's OS-specific CI/release jobs and is reported separately rather than inferred from a macOS run.
