# fake-agent

A tiny transcript-driven terminal app used as a stand-in for a real coding
agent in harness tests. It is designed to run inside a pty (spawned by the
session runtime) and behaves like an agent TUI: raw-mode input, a boot
banner, an idle prompt, keystroke echo, and busy/idle output cycles.

## Usage

```bash
node fake-agent.js [path/to/transcript.json]
```

Defaults to `transcripts/basic-echo.json`.

## Transcript format

Transcripts are JSON files:

```jsonc
{
  "name": "basic-echo",
  "synthetic": true,          // true = hand-written; false = recorded from a real agent
  "description": "…",
  "echoKeystrokes": true,     // echo bytes as they are typed (default true)
  "announceResize": false,    // print "[resize] COLSxROWS" on terminal resize
  "ignoreSigterm": false,     // ignore SIGTERM (lets tests exercise forced kill)
  "boot": [ /* steps played once on startup */ ],
  "onLine": [ /* steps played for each line typed on stdin */ ]
}
```

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

## Adding recordings

New transcripts can be recorded from real agents (capture pty output chunks
with timing, convert to `print`/`wait` steps). Before committing a
recording, sanitize it: no usernames, no real filesystem paths, no account
information. Mark hand-written transcripts with `"synthetic": true` and
recorded ones with `"synthetic": false`.
