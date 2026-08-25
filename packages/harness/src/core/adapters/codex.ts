/**
 * codex adapter — launches/resumes the `codex` CLI and scans its rollout
 * store for resumable history. Codex has no hook system (see
 * core/collector/codex-tailer.ts for how its analytics eventSource works
 * instead); this file only covers process launch/resume/doctor/history.
 *
 * Verified against a locally installed `codex-cli 0.134.0`: `codex resume
 * [SESSION_ID] [PROMPT]` (positional UUID or thread name) via `codex resume
 * --help`; the generic `-c key=value` config-override mechanism via `codex
 * --help`; and, via real spawns with `--strict-config`, that both
 * `developer_instructions` and `model_instructions_file` are real,
 * recognized keys (an earlier version of this file used the latter and
 * flagged both as unconfirmed — see buildConfigArgs below for why the
 * adapter now uses `developer_instructions` instead: `model_instructions_file`
 * makes codex's own startup depend on re-reading a file we already have the
 * content of, and an unreadable path there kills the process instantly with
 * no trust prompt, no TUI — precisely the "session has no live pty" a user
 * sees with zero indication why).
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type {
  DoctorCheck,
  HarnessAdapter,
  LaunchOpts,
  PastSessionRecord,
  SpawnSpec,
} from "../../shared/types.js";
import { stripAnsi } from "../strip-ansi.js";

const execFileAsync = promisify(execFile);

/** Bytes read from the head of a rollout file to find its session_meta line
 * and an early title candidate. Unlike Claude's transcripts (where a summary
 * lands near the end), Codex has no end-of-session summary line, so the
 * earliest user message is the best available title — and it's always near
 * the start of the file. */
const ROLLOUT_HEAD_BYTES = 65_536;
const MAX_SCAN_DEPTH = 4; // ~/.codex/sessions/YYYY/MM/DD/*.jsonl

/**
 * Turn a rendered phrase into a pattern that also matches Codex's cursor-
 * positioned output. Confirmed against real captures: the TUI can position
 * each *word* separately instead of emitting literal spaces
 * (`trust\x1b[3;16Hthe\x1b[3;20H...`), so `stripAnsi()` leaves adjacent words.
 * `\s*` accepts both that representation and ordinary terminal text.
 */
function tuiPhrase(phrase: string): RegExp {
  const escapedWords = phrase
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escapedWords.join("\\s*"), "i");
}

/**
 * Recognizable signatures for Codex screens that need a human choice before
 * the composer is safe for injected input. A signature may require multiple
 * phrases so ordinary agent output mentioning one short label does not hold
 * later programmatic input indefinitely.
 *
 * These strings are verified against codex-cli 0.147.0's onboarding, auth,
 * model-migration, personality, and theme-picker sources. Detection remains
 * deliberately best-effort: when Codex adds a new interactive startup screen,
 * its stable rendered copy must be added here.
 */
const BLOCKING_PROMPT_SIGNATURES: readonly (readonly RegExp[])[] = [
  [
    tuiPhrase("trust the contents of this directory"),
    tuiPhrase("Yes, continue"),
    tuiPhrase("No, quit"),
  ],
  [
    tuiPhrase("Sign in with ChatGPT to use Codex as part of your paid plan"),
    tuiPhrase("connect an API key for usage-based billing"),
  ],
  [
    tuiPhrase("Finish signing in via your browser"),
    tuiPhrase("open the following link to authenticate"),
  ],
  [
    tuiPhrase("Preparing device code login"),
    tuiPhrase("Open this link in your browser and sign in"),
  ],
  [
    tuiPhrase("Use your own OpenAI API key for usage-based billing"),
    tuiPhrase("Paste or type your API key"),
  ],
  [
    tuiPhrase("Before you start"),
    tuiPhrase("Decide how much autonomy you want to grant Codex"),
  ],
  [
    tuiPhrase("Codex just got an upgrade"),
    tuiPhrase("Choose how you'd like Codex to proceed"),
  ],
  [
    tuiPhrase("Select Personality"),
    tuiPhrase("Choose a communication style for Codex"),
  ],
  [tuiPhrase("Select Syntax Theme"), tuiPhrase("Type to filter themes")],
];

/**
 * Stable empty-composer copy across supported Codex CLI releases. This is not
 * required for the ordinary already-trusted path; SessionManager uses it to
 * prove that a previously detected onboarding screen has actually been
 * replaced. Keep older copy here as well as newer copy: a real 0.143.0 startup
 * renders "Use /skills to list available skills", while 0.147.0 renders "Ask
 * Codex to do anything". Without both, accepting a trust prompt on 0.143.0
 * leaves the safety latch closed even though the composer is visible.
 */
const READY_PROMPT_PATTERNS = [
  tuiPhrase("Ask Codex to do anything"),
  tuiPhrase("Use /skills to list available skills"),
];

/**
 * Copy-independent composer proof. Codex's empty input row carries the `›`
 * marker and its footer separates the mode from the cwd with `·`; onboarding
 * selectors can use the same marker, but do not render that cwd footer. The
 * blocker check in SessionManager still wins when a known modal and the
 * underlying composer are present in the same diff-rendered frame.
 */
const COMPOSER_INPUT_MARKER = /›/u;
const COMPOSER_CWD_FOOTER = /·\s*(?:~[\\/]|\/|[A-Za-z]:[\\/])/u;

export interface CodexAdapterOptions {
  /** Overridable for tests. */
  binary?: string;
  /** Overridable for tests. Defaults to the real home directory. */
  homeDir?: string;
}

interface RolloutSessionMeta {
  id: string;
  cwd: string;
  timestampMs: number | null;
}

interface RolloutLine {
  type?: string;
  payload?: Record<string, unknown>;
}

/** Read only the head of a (possibly huge) rollout file and extract its
 * `session_meta` entry. Codex always writes `session_meta` as the first
 * line, but this tolerates a few leading blank/malformed lines defensively. */
async function readSessionMeta(filePath: string, maxBytes = ROLLOUT_HEAD_BYTES): Promise<RolloutSessionMeta | null> {
  let content: string;
  try {
    const handle = await open(filePath, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, 0);
      content = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  for (const line of content.split("\n").slice(0, 20)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: RolloutLine;
    try {
      parsed = JSON.parse(trimmed) as RolloutLine;
    } catch {
      continue;
    }
    if (parsed.type !== "session_meta") continue;
    const payload = parsed.payload;
    const id = typeof payload?.id === "string" ? payload.id : undefined;
    const cwd = typeof payload?.cwd === "string" ? payload.cwd : undefined;
    if (!id || !cwd) return null;
    const timestamp = typeof payload?.timestamp === "string" ? Date.parse(payload.timestamp) : NaN;
    return { id, cwd, timestampMs: Number.isNaN(timestamp) ? null : timestamp };
  }
  return null;
}

/** First `event_msg`/`user_message` found in the head of the file, truncated
 * for use as a session title. Falls back to `fallback` when none is found
 * within the head window (long system-prompt-only sessions, mid-tail-cut). */
function extractTitleFromHead(content: string, fallback: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: RolloutLine;
    try {
      parsed = JSON.parse(trimmed) as RolloutLine;
    } catch {
      continue;
    }
    if (parsed.type !== "event_msg" || parsed.payload?.type !== "user_message") continue;
    const message = parsed.payload.message;
    if (typeof message === "string" && message.trim()) {
      const text = message.trim();
      return text.length > 120 ? `${text.slice(0, 120)}...` : text;
    }
  }
  return fallback;
}

/**
 * The cwd strings a rollout's `session_meta.cwd` could carry for this
 * directory: the path as given, plus its realpath when they differ.
 *
 * Claude Code is confirmed to record the realpath rather than the path a
 * session was opened through (see `projectDirsFor` in the claude-code adapter
 * — on macOS `/tmp` is a symlink to `/private/tmp`, and both encodings exist
 * in a real `~/.claude`). Codex's own behaviour here is NOT vendor-confirmed,
 * so this accepts either form rather than betting on one: matching a superset
 * can only find rollouts that a raw string comparison would have missed, and
 * a resumability probe answering "no" for a conversation that exists is the
 * failure mode worth engineering against.
 */
async function cwdVariants(cwd: string): Promise<Set<string>> {
  const variants = new Set([cwd]);
  const resolved = await realpath(cwd).catch(() => undefined);
  if (resolved) variants.add(resolved);
  return variants;
}

/** Recursively collect `.jsonl` files under Codex's date-sharded sessions
 * root (`YYYY/MM/DD/rollout-*.jsonl`). Bounded depth as a safety guard
 * against unexpectedly deep/cyclical directory structures. */
async function collectRolloutFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectRolloutFiles(fullPath, depth + 1)));
    } else if (entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex" as const;
  readonly eventSource = "transcript-tail" as const;
  /** `buildConfigArgs` inlines `systemPromptFile`'s contents as
   *  `developer_instructions`, on both launch and resume — same delivery as
   *  claude-code's flag, so a rehydration brief rides the generated file here
   *  too and neither adapter needs a rehydration-specific code path. */
  readonly systemPromptDelivery = "launch-flag" as const;
  private readonly binary: string;
  private readonly homeDir: string;

  constructor(options: CodexAdapterOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.homeDir = options.homeDir ?? homedir();
  }

  async doctor(): Promise<DoctorCheck[]> {
    try {
      const { stdout } = await execFileAsync(this.binary, ["--version"], { timeout: 5_000, windowsHide: true });
      return [{ name: "codex", ok: true, detail: stdout.trim() || "installed" }];
    } catch {
      return [
        {
          name: "codex",
          ok: false,
          detail: `\`${this.binary}\` not found on PATH. Install: https://github.com/openai/codex`,
        },
      ];
    }
  }

  launch(opts: LaunchOpts): SpawnSpec {
    return {
      command: this.binary,
      args: buildConfigArgs(opts),
      // Codex has no analog to Claude's CLAUDECODE nested-agent guard; no env
      // overrides are needed for a fresh launch.
      env: {},
      cwd: opts.cwd,
    };
  }

  resume(agentSessionId: string, opts: LaunchOpts): SpawnSpec {
    return {
      command: this.binary,
      args: ["resume", agentSessionId, ...buildConfigArgs(opts)],
      env: {},
      cwd: opts.cwd,
    };
  }

  /**
   * See `HarnessAdapter.readyFallback` and `detectBlockingPrompt`. Codex's
   * rollout file — and therefore the SessionStart-equivalent event
   * `SessionManager` otherwise waits on — isn't written until the first turn
   * is submitted. Confirmed empirically against codex-cli 0.134.0: an idle,
   * fully-interactive session produces no rollout for as long as nothing is
   * submitted. SessionManager therefore publishes fallback readiness after a
   * non-blocking frame settles (or reaches its bounded liveness ceiling),
   * while retaining the same check at request time.
   */
  readonly readyFallback = "immediate" as const;

  detectBlockingPrompt(scrollback: string): boolean {
    const rendered = stripAnsi(scrollback);
    return BLOCKING_PROMPT_SIGNATURES.some((signature) =>
      signature.every((pattern) => pattern.test(rendered)),
    );
  }

  detectReadyPrompt(terminalOutput: string): boolean {
    const rendered = stripAnsi(terminalOutput);
    return (
      READY_PROMPT_PATTERNS.some((pattern) => pattern.test(rendered)) ||
      (COMPOSER_INPUT_MARKER.test(rendered) &&
        COMPOSER_CWD_FOOTER.test(rendered))
    );
  }

  /**
   * See `HarnessAdapter.canResume`. Reuses the same rollout walk +
   * `session_meta` read `listPastSessions` is built on, so "codex has this
   * conversation" means exactly one thing in both places: a rollout file
   * under `~/.codex/sessions` whose `session_meta` carries this id AND this
   * cwd. The cwd match matters — `codex resume <id>` run from another
   * directory is a different session's context, not this row.
   *
   * The never-prompted case documented on `detectBlockingPrompt` is why this
   * can be false for an id we hold: codex writes no rollout file at all until
   * the first turn is submitted, so a session the user opened and abandoned
   * leaves us a `SessionStart` id with nothing behind it.
   */
  async canResume(agentSessionId: string, cwd: string): Promise<boolean> {
    if (!agentSessionId) return false;
    const root = join(this.homeDir, ".codex", "sessions");
    const cwds = await cwdVariants(cwd);
    for (const filePath of await collectRolloutFiles(root)) {
      const meta = await readSessionMeta(filePath);
      if (meta?.id === agentSessionId && cwds.has(meta.cwd)) return true;
    }
    return false;
  }

  async listPastSessions(cwd: string): Promise<PastSessionRecord[]> {
    const root = join(this.homeDir, ".codex", "sessions");
    const files = await collectRolloutFiles(root);
    const cwds = await cwdVariants(cwd);

    const summaries: PastSessionRecord[] = [];
    for (const filePath of files) {
      const meta = await readSessionMeta(filePath);
      if (!meta || !cwds.has(meta.cwd)) continue;

      const fileStat = await stat(filePath).catch(() => undefined);
      const lastActiveAt = fileStat ? fileStat.mtime.toISOString() : new Date(0).toISOString();

      let title = basename(filePath, ".jsonl");
      try {
        const handle = await open(filePath, "r");
        try {
          const { size } = await handle.stat();
          const length = Math.min(size, ROLLOUT_HEAD_BYTES);
          const buffer = Buffer.allocUnsafe(length);
          await handle.read(buffer, 0, length, 0);
          title = extractTitleFromHead(buffer.toString("utf8"), meta.id);
        } finally {
          await handle.close();
        }
      } catch {
        // Fall back to the rollout id as the title.
      }

      summaries.push({
        agentSessionId: meta.id,
        harness: "codex",
        cwd,
        title,
        lastActiveAt,
        source: "transcript",
      });
    }

    return summaries.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
  }
}

/**
 * Codex has no single-flag equivalent to Claude's `--append-system-prompt` /
 * `--mcp-config` — MCP servers are registered globally via `codex mcp add`
 * (a persistent config.toml mutation, which the harness's "zero config
 * mutation" design deliberately avoids), so `opts.mcpConfigFile` /
 * `opts.settingsFile` are intentionally unused here. System-prompt injection
 * uses the generic `-c key=value` override mechanism instead.
 *
 * Confirmed against a locally installed codex-cli 0.134.0: `-c
 * model_instructions_file=<path>` is a real, recognized key — but if that
 * path is missing/unreadable at codex's own startup (a moment we don't
 * control, in a separate process), codex exits immediately with a config
 * error, no trust prompt, no TUI — which reads to a user as the session
 * dying instantly. Since we already have the prompt's content in hand
 * (we're the ones who generated the file), embedding it inline via
 * `developer_instructions=<value>` instead removes that dependency
 * entirely: nothing for codex to fail to (re)read. `-c` values parse as
 * TOML, and TOML basic strings share JSON's escaping rules for control
 * characters/quotes/backslashes, so `JSON.stringify` produces a valid TOML
 * string literal here — confirmed with a real multiline prompt.
 *
 * If even this read fails (the file we just generated is somehow gone by
 * the time we get here — a narrow race, but still no reason to crash the
 * whole session over an optional prompt), fall back to launching without
 * one rather than passing a broken reference that's guaranteed to kill the
 * process on startup.
 */
function buildConfigArgs(opts: LaunchOpts): string[] {
  const args = [
    "-c",
    "check_for_update_on_startup=false",
    // Codex's default approval policy interrupts the session with "Would you
    // like to run the following command?" prompts (even for read-only
    // commands like `ps`). Harness sessions are expected to run without
    // approval interruptions — the analog of Claude Code sessions, which the
    // harness runs in auto mode — so pin codex's non-interactive pairing:
    // never ask for approval, and confine writes to the workspace via the OS
    // sandbox instead of via per-command human review. Both keys and their
    // values confirmed against a locally installed codex-cli 0.134.0 (its
    // config deserializer enumerates `never` / `workspace-write` among the
    // accepted variants when probed with a bogus value). `-c` values parse
    // as TOML, so the string values need the embedded quotes.
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="workspace-write"',
  ];
  if (opts.systemPromptFile) {
    try {
      const prompt = readFileSync(opts.systemPromptFile, "utf8");
      args.push("-c", `developer_instructions=${JSON.stringify(prompt)}`);
    } catch (err) {
      console.error(
        `[codex adapter] could not read systemPromptFile "${opts.systemPromptFile}" — launching without an injected system prompt: ${(err as Error).message}`,
      );
    }
  }
  return args;
}

export function createCodexAdapter(options?: CodexAdapterOptions): HarnessAdapter {
  return new CodexAdapter(options);
}
