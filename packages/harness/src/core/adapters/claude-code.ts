/**
 * claude-code adapter — launches/resumes the `claude` CLI and scans its
 * transcript store for resumable history. All Sapiom-ness is injected via
 * flags (settings/mcp-config/system-prompt); nothing here mutates the user's
 * own `~/.claude` config.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, readdir, realpath, stat, open } from "node:fs/promises";
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

/**
 * Minimum `claude` version the harness supports.
 *
 * Below this, the binary predates flags {@link ClaudeCodeAdapter.launch} /
 * `resume` inject on EVERY spawn — most importantly `--plugin-dir`. A
 * commander-style CLI aborts on an unknown option with a fast `exit 1`, BEFORE
 * it ever runs its SessionStart hook, so the session dies with no
 * `agentSessionId` and only an opaque exit code (the pty's stderr is discarded
 * on exit) — exactly the "exited before establishing a session id" failure
 * users report. `doctor()` reports a below-floor claude as NOT ok so the
 * desktop host installs a current one and the CLI surfaces an actionable
 * upgrade remedy, instead of every session crash-looping silently.
 *
 * Why 2.1.0, from the Claude Code CHANGELOG:
 * - The plugin system did not exist before the "Plugin System Released" entry
 *   in `2.0.12`, so no `1.x` or `2.0.0`–`2.0.11` build can recognize
 *   `--plugin-dir` — they reject it outright.
 * - The changelog itemizes `--plugin-dir` only as modifications from `2.1.74`
 *   onward, and the harness's own `--plugin-dir` skills usage is verified
 *   against `2.1.x` (see core/inject/skills-plugin.ts). `2.1.x` is thus the
 *   earliest range we can GUARANTEE both recognizes the flag and loads our
 *   skills.
 * We floor at `2.1.0` — the earliest verified-safe version — rather than the
 * `2.0.12` plugin-system release, because we can't prove `--plugin-dir` is
 * present across the whole `2.0.x` line, and a spurious "please upgrade" for a
 * rare old-`2.0.x` install is far cheaper than the silent exit-1 crash-loop
 * this floor exists to prevent. This is the SINGLE source of truth — bump it
 * whenever the adapter starts sending a flag, or relying on behavior, a newer
 * `claude` introduced.
 */
export const MIN_CLAUDE_CODE_VERSION = "2.1.0";

/**
 * Extract a leading `major.minor.patch` from a `claude --version` line such as
 * `"2.1.3 (Claude Code)"`. Returns null when no semver is present.
 */
export function parseClaudeVersion(
  versionLine: string | null | undefined,
): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionLine ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether a `claude --version` line is at least {@link MIN_CLAUDE_CODE_VERSION}.
 *
 * Deliberately surgical: the ONLY case treated as unsupported is a version we
 * can parse AND that is below the floor. An absent or unparseable version
 * returns `true` (supported) so a future change to claude's `--version` format
 * can never mass-reject working installs — the floor exists to catch provably
 * ancient binaries, not to gate on our own parser's limits.
 */
export function isClaudeVersionSupported(versionLine: string | null | undefined): boolean {
  const parsed = parseClaudeVersion(versionLine);
  if (!parsed) return true;
  const floor = parseClaudeVersion(MIN_CLAUDE_CODE_VERSION)!;
  for (let i = 0; i < 3; i++) {
    if (parsed[i] > floor[i]) return true;
    if (parsed[i] < floor[i]) return false;
  }
  return true;
}

/**
 * Maps a project cwd to the directory name Claude Code uses for its transcript
 * store under `~/.claude/projects/`. Claude Code applies this encoding before
 * creating the directory — see its own source for the canonical definition.
 *
 * Exported so tests assert against the real encoder rather than a copy of it:
 * a private duplicate in the test file is exactly the thing that would let
 * encoder drift pass the tests written to catch it.
 *
 * Encodes the path as given. Callers starting from a user-supplied cwd want
 * {@link projectDirsFor}, which handles the symlink case this encoder can't
 * see on its own — see its docstring.
 */
export function encodeProjectPath(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  return normalized.replace(/:/g, "").replace(/[/.]/g, "-");
}

/**
 * Every directory under `~/.claude/projects` that could hold `cwd`'s
 * transcripts, realpath-resolved form first.
 *
 * Claude Code encodes the cwd's **realpath**, not the path the session was
 * opened through — so a session in `/tmp/foo` on macOS stores its transcripts
 * under the encoding of `/private/tmp/foo` (`/tmp` is a symlink), and one in
 * `os.tmpdir()` under `/private/var/folders/…`. Both shapes are present in a
 * real `~/.claude` on this machine. Encoding the registry's raw `cwd` string
 * therefore stats a path that does not exist, which for a resumability probe
 * is worse than a miss: it reports "the agent has no conversation" for a
 * conversation the agent has, and refuses a resume that would have worked.
 *
 * The raw form is kept as a second candidate (when it differs) so nothing that
 * resolved before can stop resolving, and a cwd that no longer exists on disk
 * — realpath fails — still falls back to it.
 *
 * Exported for the session-record reader's optional vendor enrichment
 * (core/session-record.ts), which reads the same transcript files. Claude's
 * directory layout — symlink handling included — is defined here once.
 */
export async function projectDirsFor(homeDir: string, cwd: string): Promise<string[]> {
  const names = new Set<string>();
  const resolved = await realpath(cwd).catch(() => undefined);
  if (resolved) names.add(encodeProjectPath(resolved));
  names.add(encodeProjectPath(cwd));
  return [...names].map((name) => join(homeDir, ".claude", "projects", name));
}

/**
 * A session id we're willing to interpolate into a transcript path. Claude
 * Code's ids are UUIDs; anything carrying a separator or a `..` segment is
 * either corrupt registry data or an attempt to walk out of the project dir
 * via `POST /api/sessions/adopt`, and is never a real transcript either way.
 */
function isSafeSessionId(agentSessionId: string): boolean {
  return agentSessionId.length > 0 && /^[A-Za-z0-9._-]+$/.test(agentSessionId) && !agentSessionId.includes("..");
}

const execFileAsync = promisify(execFile);

/** Bytes read from each end of a transcript that's too large to fully scan.
 * The head holds the first prompt (a title fallback); the tail holds the
 * latest ai-title/summary and the most recent git branch. */
const TRANSCRIPT_WINDOW_BYTES = 65_536;

/**
 * Transcripts at or below this size are read in full, which yields an exact
 * turn count and a title drawn from the whole session. Larger transcripts
 * (Claude's JSONL can reach 100MB+) are read only at head+tail — scanning them
 * on every history-dropdown open would be prohibitively slow — so their turn
 * count is reported as unknown rather than a wrong partial count.
 */
const DEFAULT_FULL_SCAN_MAX_BYTES = 5_242_880; // 5 MiB

export interface ClaudeCodeAdapterOptions {
  /** Overridable for tests (e.g. spawn `bash` instead of a real, auth-gated `claude`). */
  binary?: string;
  /** Overridable for tests. Defaults to the real home directory. */
  homeDir?: string;
  /** Overridable for tests. Max transcript size (bytes) to read in full for an
   *  exact turn count; larger files are read only at head+tail. */
  fullScanMaxBytes?: number;
}

interface TranscriptEntry {
  type?: string;
  /** Older-format compaction summary (`type: "summary"`). */
  summary?: string;
  /** Claude's own generated session title (`type: "ai-title"`). */
  aiTitle?: string;
  /** Git branch recorded on user/assistant entries. */
  gitBranch?: string;
  /** True on internal sub-agent entries — never a real user turn. */
  isSidechain?: boolean;
  /** Present on user entries; `kind: "human"` marks a typed prompt (vs a
   *  tool-result echoed back with role "user"). */
  origin?: { kind?: string };
  message?: { role?: string; content?: unknown };
}


function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? (block as { text?: unknown }).text
          : undefined,
      )
      .filter((text): text is string => typeof text === "string");
    return texts.length > 0 ? texts.join(" ") : undefined;
  }
  return undefined;
}

/** Parse the JSONL lines of a transcript slice into entries, skipping blank or
 * malformed lines. `dropFirst`/`dropLast` discard a possibly-truncated edge
 * line when the slice was cut mid-file (tail starts mid-line; head ends
 * mid-line). */
function parseTranscriptLines(
  text: string,
  { dropFirst = false, dropLast = false }: { dropFirst?: boolean; dropLast?: boolean } = {},
): TranscriptEntry[] {
  const lines = text.split("\n");
  const start = dropFirst ? 1 : 0;
  const end = dropLast ? lines.length - 1 : lines.length;
  const entries: TranscriptEntry[] = [];
  for (let i = start; i < end; i++) {
    const trimmed = lines[i]?.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        entries.push(parsed as TranscriptEntry);
      }
    } catch {
      // Skip malformed/truncated lines (expected at a sliced file boundary).
    }
  }
  return entries;
}

interface TranscriptScan {
  /** Chronological head-window entries (or all entries when fully scanned). */
  head: TranscriptEntry[];
  /** Chronological tail-window entries (or all entries when fully scanned). */
  tail: TranscriptEntry[];
  /** Exact human-turn count when the file was small enough to scan in full;
   *  undefined otherwise. */
  messageCount?: number;
}

/**
 * Read a transcript for summarization. Small files are read in full (exact
 * turn count, title from the whole session); large files are read only at
 * head+tail windows so the history dropdown never has to parse a 100MB file.
 */
async function scanTranscript(
  filePath: string,
  size: number,
  fullScanMaxBytes: number,
): Promise<TranscriptScan> {
  if (size <= fullScanMaxBytes) {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return { head: [], tail: [] };
    }
    const all = parseTranscriptLines(content);
    return { head: all, tail: all, messageCount: countUserTurns(all) };
  }

  const window = TRANSCRIPT_WINDOW_BYTES;
  let head: TranscriptEntry[] = [];
  let tail: TranscriptEntry[] = [];
  try {
    const handle = await open(filePath, "r");
    try {
      const headBuf = Buffer.allocUnsafe(window);
      await handle.read(headBuf, 0, window, 0);
      // The head window likely ends mid-line — drop that partial last line.
      head = parseTranscriptLines(headBuf.toString("utf8"), { dropLast: true });

      const tailBuf = Buffer.allocUnsafe(window);
      await handle.read(tailBuf, 0, window, size - window);
      // The tail window likely starts mid-line — drop that partial first line.
      tail = parseTranscriptLines(tailBuf.toString("utf8"), { dropFirst: true });
    } finally {
      await handle.close();
    }
  } catch {
    return { head: [], tail: [] };
  }
  return { head, tail };
}

/** A user entry that represents a real human prompt — not an internal
 * sub-agent turn and not a tool-result echoed back with role "user". */
function isHumanTurn(entry: TranscriptEntry): boolean {
  if (entry?.type !== "user" || entry.isSidechain === true) return false;
  // Newer transcripts tag typed prompts with origin.kind === "human"; older
  // ones omit origin entirely, so accept a missing origin too.
  if (entry.origin?.kind && entry.origin.kind !== "human") return false;
  // Tool results carry no plain text (their content is tool_result blocks);
  // requiring extractable text excludes them.
  return Boolean(extractTextFromContent(entry.message?.content)?.trim());
}

function countUserTurns(entries: TranscriptEntry[]): number {
  return entries.reduce((n, entry) => (isHumanTurn(entry) ? n + 1 : n), 0);
}

/** Latest non-empty value of `field` on entries of type `type`, scanning
 * newest-first. Used for ai-title / summary (title candidates). */
function latestValue(
  entries: TranscriptEntry[],
  type: string,
  field: "aiTitle" | "summary",
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === type && typeof entry[field] === "string" && entry[field]!.trim()) {
      return entry[field]!.trim();
    }
  }
  return undefined;
}

function truncateTitle(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

/**
 * A human-readable title for a resumable session — never a bare UUID. In
 * preference order: Claude's own generated title (`ai-title`), the older
 * compaction `summary`, then the first human prompt. The latest ai-title /
 * summary is preferred, and it lands in the tail window on long sessions
 * (that's why we scan the tail); the first prompt is a head-window fallback
 * for transcripts that have neither. Only when a session has no title, no
 * summary, and no human prompt at all do we use `fallback`.
 */
function extractTitle(
  head: TranscriptEntry[],
  tail: TranscriptEntry[],
  fallback: string,
): string {
  const aiTitle = latestValue(tail, "ai-title", "aiTitle") ?? latestValue(head, "ai-title", "aiTitle");
  if (aiTitle) return truncateTitle(aiTitle);

  const summary = latestValue(tail, "summary", "summary") ?? latestValue(head, "summary", "summary");
  if (summary) return truncateTitle(summary);

  for (const entry of head) {
    if (!isHumanTurn(entry)) continue;
    const text = extractTextFromContent(entry.message?.content)?.trim();
    if (text) return truncateTitle(text);
  }
  return fallback;
}

/** Most recent git branch recorded on a message entry, newest-first (tail then
 * head), or undefined when the transcript records none. */
function extractGitBranch(head: TranscriptEntry[], tail: TranscriptEntry[]): string | undefined {
  for (const entries of [tail, head]) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const branch = entries[i]?.gitBranch;
      if (typeof branch === "string" && branch.trim()) return branch.trim();
    }
  }
  return undefined;
}

function buildConfigArgs(opts: LaunchOpts): string[] {
  const args: string[] = [];
  if (opts.settingsFile) args.push("--settings", opts.settingsFile);
  if (opts.mcpConfigFile) args.push("--mcp-config", opts.mcpConfigFile);
  if (opts.pluginDir) args.push("--plugin-dir", opts.pluginDir);
  return args;
}

/**
 * Claude Code's known blocking startup screens, matched against stripped-ANSI
 * scrollback. Exported so the packaged smoke / e2e layers can pin the same
 * patterns this adapter gates the ready-fallback on (see detectBlockingPrompt).
 * Wording verified against Claude Code 2.1.x; a future rewording fails SAFE:
 * an unmatched dialog only means the fallback flips `ready` and the injected
 * prompt lands in a dialog the user is looking at anyway — the pre-fallback
 * behaviour was the prompt silently vanishing after ten minutes.
 */
export const CLAUDE_BLOCKING_PROMPT_PATTERNS: readonly RegExp[] = [
  // First-run / new-directory trust dialog.
  /do\s+you\s+trust\s+the\s+files\s+in\s+this\s+(folder|directory)/i,
  // First-run theme picker.
  /choose\s+the\s+text\s+style/i,
  // Signed-out login flow.
  /select\s+login\s+method|sign\s+in\s+to\s+(use\s+)?claude/i,
];

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code" as const;
  readonly eventSource = "hooks" as const;
  /** `--append-system-prompt` carries `systemPromptFile`'s contents on every
   *  launch/resume path below, so a rehydration brief composed into that file
   *  needs no separate delivery. */
  readonly systemPromptDelivery = "launch-flag" as const;
  /**
   * See `HarnessAdapter.readyFallback`. The SessionStart hook stays the
   * primary signal (isReadyEnough gives claude-code NO immediate scrollback
   * shortcut); this only lets SessionManager's generously-timed fallback
   * rescue a session whose hook chain is broken — on Windows the hook runs
   * `node` through Claude's hook shell, and when that resolution fails the
   * POST never fires, `ready` never flips, and the held first prompt was
   * silently dropped.
   */
  readonly readyFallback = "hook-timeout" as const;
  /**
   * See `HarnessAdapter.assumesBracketedPaste`. Claude Code's Ink input layer
   * enables mode 2004 in every interactive session — the macOS/Linux paste
   * detection observing `ESC[?2004h` on real ptys is the in-repo evidence.
   * Declared so Windows (where ConPTY hides that announcement) still paste-
   * wraps multi-line prompts instead of submitting at the first newline.
   */
  readonly assumesBracketedPaste = true;
  private readonly binary: string;
  private readonly homeDir: string;
  private readonly fullScanMaxBytes: number;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.homeDir = options.homeDir ?? homedir();
    this.fullScanMaxBytes = options.fullScanMaxBytes ?? DEFAULT_FULL_SCAN_MAX_BYTES;
  }

  /**
   * See `HarnessAdapter.detectBlockingPrompt` and `readyFallback` above: this
   * exists ONLY to gate the hook-timeout fallback (never type a stray Enter
   * into an unanswered trust dialog) — it deliberately does NOT give
   * claude-code Codex's immediate scrollback shortcut, because the hook is
   * reliable wherever the hook chain itself works.
   */
  detectBlockingPrompt(scrollback: string): boolean {
    const cleaned = stripAnsi(scrollback);
    return CLAUDE_BLOCKING_PROMPT_PATTERNS.some((pattern) => pattern.test(cleaned));
  }

  async doctor(): Promise<DoctorCheck[]> {
    let versionLine: string;
    try {
      const { stdout } = await execFileAsync(this.binary, ["--version"], { timeout: 5_000, windowsHide: true });
      versionLine = stdout.trim();
    } catch {
      return [
        {
          name: "claude",
          ok: false,
          detail: `\`${this.binary}\` not found on PATH. Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup`,
        },
      ];
    }
    // A too-old claude passes "is it on PATH" but rejects the flags we inject on
    // every launch (see MIN_CLAUDE_CODE_VERSION), so it must report NOT ok — a
    // green doctor for a binary that exit-1s every session is worse than none.
    if (!isClaudeVersionSupported(versionLine)) {
      return [
        {
          name: "claude",
          ok: false,
          detail: `\`${this.binary}\` is ${versionLine || "an unknown version"}, older than the required ${MIN_CLAUDE_CODE_VERSION}. Upgrade Claude Code: https://docs.claude.com/en/docs/claude-code/setup`,
        },
      ];
    }
    return [{ name: "claude", ok: true, detail: versionLine || "installed" }];
  }

  launch(opts: LaunchOpts): SpawnSpec {
    const args = buildConfigArgs(opts);
    if (opts.systemPromptFile) {
      args.push("--append-system-prompt", readPromptFile(opts.systemPromptFile));
    }
    return {
      command: this.binary,
      args,
      // Nested-agent conflict: Claude Code refuses to run "inside itself" if
      // CLAUDECODE is already set, which it will be if the harness server
      // itself was launched from within a Claude Code session.
      env: { CLAUDECODE: null },
      cwd: opts.cwd,
    };
  }

  resume(agentSessionId: string, opts: LaunchOpts): SpawnSpec {
    const args = ["--resume", agentSessionId, ...buildConfigArgs(opts)];
    if (opts.systemPromptFile) {
      args.push("--append-system-prompt", readPromptFile(opts.systemPromptFile));
    }
    return {
      command: this.binary,
      args,
      env: { CLAUDECODE: null },
      cwd: opts.cwd,
    };
  }

  /**
   * Headless one-shot run for TaskManager (see HarnessAdapter.launchTask).
   * Verified against a real `claude` binary: `-p` carries the exact same
   * --settings/--mcp-config/--append-system-prompt injection as launch()
   * (all six hooks fire), skips the trust dialog entirely, and exits on its
   * own when the turn completes. The extra flags:
   * - --permission-mode acceptEdits: a headless task has no human to click
   *   through a permission prompt — without it a tool call hangs forever.
   * - --output-format stream-json --verbose: line-oriented JSON progress on
   *   stdout (parsed by core/task-stream.ts) instead of a bare final answer.
   * - --model / --max-turns: only when the caller sets them — a bounded task
   *   (canvas enrichment) pins a cheaper model and a hard turn cap instead of
   *   inheriting the user's interactive defaults.
   */
  launchTask(opts: LaunchOpts): SpawnSpec {
    if (!opts.prompt) {
      throw new Error("claude-code adapter: launchTask requires opts.prompt");
    }
    const args = ["-p", opts.prompt, ...buildConfigArgs(opts)];
    if (opts.systemPromptFile) {
      args.push("--append-system-prompt", readPromptFile(opts.systemPromptFile));
    }
    if (opts.model) args.push("--model", opts.model);
    if (opts.maxTurns != null) args.push("--max-turns", String(opts.maxTurns));
    args.push("--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose");
    return {
      command: this.binary,
      args,
      env: { CLAUDECODE: null },
      cwd: opts.cwd,
    };
  }

  /**
   * See `HarnessAdapter.canResume`. One `stat` per candidate project dir on the
   * transcript `claude --resume <id>` would read — `<project dir>/<id>.jsonl`
   * — sharing `projectDirsFor` with `listPastSessions` so the vendor's
   * directory layout, symlink handling included, stays defined in one place.
   *
   * A zero-byte file counts as absent: the transcript is created before the
   * first turn is written, so an empty one is precisely the never-prompted
   * session that `--resume` rejects with "No conversation found".
   *
   * Deliberately a weaker test than `listPastSessions`', which additionally
   * requires a line OUR parser understands. A non-empty transcript we can't
   * parse is still Claude's to interpret, and refusing the resume on the
   * strength of our own parser's limits would be the same fail-closed mistake
   * as the symlink bug above. So this can say `agent-resume` for a transcript
   * that never shows up as a history row of its own.
   */
  async canResume(agentSessionId: string, cwd: string): Promise<boolean> {
    if (!isSafeSessionId(agentSessionId)) return false;
    for (const projectDir of await projectDirsFor(this.homeDir, cwd)) {
      const fileStat = await stat(join(projectDir, `${agentSessionId}.jsonl`)).catch(() => undefined);
      if (fileStat != null && fileStat.isFile() && fileStat.size > 0) return true;
    }
    return false;
  }

  async listPastSessions(cwd: string): Promise<PastSessionRecord[]> {
    const summaries: PastSessionRecord[] = [];
    // Deduped across candidate dirs: a cwd whose realpath differs contributes
    // two directories, and the same session must not surface twice.
    const seen = new Set<string>();
    for (const projectDir of await projectDirsFor(this.homeDir, cwd)) {
      let entries: string[];
      try {
        entries = await readdir(projectDir);
      } catch {
        continue;
      }

      for (const file of entries) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = join(projectDir, file);
        const agentSessionId = basename(file, ".jsonl");
        if (seen.has(agentSessionId)) continue;
        const fileStat = await stat(filePath).catch(() => undefined);
        if (!fileStat) continue;
        const { head, tail, messageCount } = await scanTranscript(
          filePath,
          fileStat.size,
          this.fullScanMaxBytes,
        );
        if (head.length === 0 && tail.length === 0) continue;
        seen.add(agentSessionId);
        summaries.push({
          agentSessionId,
          harness: "claude-code",
          // The cwd the CALLER asked about, not the resolved one — this row is
          // how that directory's history is presented, and a session started
          // in it must resume in it.
          cwd,
          // Never a bare UUID: falls back to the directory basename, not the
          // session id, when a session has no title/summary/prompt at all.
          title: extractTitle(head, tail, basename(cwd) || agentSessionId),
          lastActiveAt: fileStat.mtime.toISOString(),
          source: "transcript",
          gitBranch: extractGitBranch(head, tail),
          messageCount,
        });
      }
    }

    return summaries.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
  }
}

function readPromptFile(path: string): string {
  // launch()/resume() are synchronous per the adapter contract, so this reads
  // synchronously; profile prompts are small (a few KB), read once at spawn time.
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `claude-code adapter: failed to read systemPromptFile "${path}": ${(err as Error).message}`,
    );
  }
}

export function createClaudeCodeAdapter(options?: ClaudeCodeAdapterOptions): HarnessAdapter {
  return new ClaudeCodeAdapter(options);
}
