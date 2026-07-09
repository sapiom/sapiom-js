# fake-agent

A tiny transcript-driven terminal app used as a stand-in for a real coding
agent in harness tests. It is designed to run inside a pty (spawned by the
session manager) and behaves like an agent TUI: raw-mode input, a boot
banner, an idle prompt, keystroke echo, and busy/idle output cycles.

## Usage

```bash
node fake-agent.cjs [path/to/transcript.json]
```

Defaults to `transcripts/basic-echo.json`.

The `.cjs` extension is required because the harness package declares `"type": "module"`, which would cause Node to treat a `.js` file as an ES module. The fake-agent uses CommonJS `require()` so it must be `.cjs`.

## Transcript format

Transcripts are JSON files:

```jsonc
{
  "name": "basic-echo",
  "synthetic": true,          // true = hand-written; false = verbatim recording from a real agent
  "modeledOn": "…",           // optional; what a hand-written transcript imitates (omit for pure inventions)
  "description": "…",
  "echoKeystrokes": true,     // echo bytes as they are typed (default true)
  "announceResize": false,    // print "[resize] COLSxROWS" on terminal resize
  "ignoreSigterm": false,     // ignore SIGTERM (lets tests exercise forced kill)
  "boot": [ /* steps played once on startup */ ],
  "onLine": [ /* steps played for each line typed on stdin */ ]
}
```

Key provenance fields:

| Field | Meaning |
| --- | --- |
| `"synthetic": true` | Hand-written — every byte was authored manually |
| `"synthetic": false` | Verbatim recording from a real agent session |
| `"modeledOn"` | Optional (only on hand-written transcripts); describes what real output the transcript imitates |

Step types (unknown types are ignored, so transcripts can evolve):

| Step | Effect |
| --- | --- |
| `{ "type": "print", "data": "…" }` | Write raw data to stdout. In `onLine` steps, `{{line}}` is replaced with the input line. |
| `{ "type": "wait", "ms": 100 }` | Pause playback. |
| `{ "type": "busy", "frames": ["⠋"], "intervalMs": 40, "cycles": 4, "label": "…", "doneData": "…" }` | Spinner-style busy cycle, then optional done output. |
| `{ "type": "print-size" }` | Print `[size] COLSxROWS` (verifies pty size plumbing). |
| `{ "type": "print-cwd" }` | Print `[cwd] <cwd>` (verifies cwd plumbing). |
| `{ "type": "print-env", "name": "VAR" }` | Print `[env] VAR=<value>` (verifies env plumbing). |

Control input: Ctrl+C exits with code 130, Ctrl+D on an empty line exits
with code 0, backspace edits the current line.

## Transcript provenance

| File | Type | Notes |
| --- | --- | --- |
| `basic-echo.json` | Synthetic (hand-written) | Minimal deterministic agent with spinner |
| `diagnostics.json` | Synthetic (hand-written) | Verifies env/cwd/cols/rows plumbing |
| `stubborn.json` | Synthetic (hand-written) | Ignores SIGTERM — exercises kill escalation |
| `claude-code-boot.json` | Hand-modeled | Hand-modeled on Claude Code v2.x boot output under a 100x30 pty; all identifiers (user, org, path) replaced with fictional values. `"synthetic": true` (not a verbatim recording); `"modeledOn"` field names the source. |

## Test consumer

The vitest suite `src/core/transcript-replay.test.ts` is the primary consumer
of these fixtures. It exercises the fake-agent directly via real node-pty
(six tests) and via the SessionManager integration path (one test).

`scripts/e2e-live.ts` keeps its own capture-oriented `scripts/fixtures/fake-claude.mjs`
fixture because that script's session lifecycle requires the spawned process to
fire real hook events (SessionStart etc.) so `session.ready` flips before any
input injection. `fake-agent.cjs` is a pure pty app with no hook-firing logic;
wiring it into `e2e-live.ts` would require either adding hook-firing to
`fake-agent.cjs` (scope creep) or calling `setReady` directly from the script
(which breaks the invariant the ready-gate exists to test). The transcript-replay
vitest tests cover the same SessionManager pty path end-to-end without
those constraints.

## Adding recordings

New transcripts can be recorded from real agents (capture pty output chunks
with timing, convert to `print`/`wait` steps). Before committing a
recording, sanitize it: no usernames, no real filesystem paths, no account
information. Mark verbatim recordings with `"synthetic": false` and include
a `"recordedFrom"` field naming the tool and version. Mark hand-written or
hand-modeled transcripts with `"synthetic": true` and, if they imitate real
output, a `"modeledOn"` field describing the source.
