/**
 * claude-code adapter — launches/resumes the `claude` CLI and scans its
 * transcript store for resumable history. All Sapiom-ness is injected via
 * flags (settings/mcp-config/system-prompt); nothing here mutates the user's
 * own `~/.claude` config.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, readdir, stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type {
  DoctorCheck,
  HarnessAdapter,
  LaunchOpts,
  SessionSummary,
  SpawnSpec,
} from "../../shared/types.js";
/**
 * Maps a project cwd to the directory name Claude Code uses for its transcript
 * store under `~/.claude/projects/`. Claude Code applies this encoding before
 * creating the directory — see its own source for the canonical definition.
 */
function encodeProjectPath(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  return normalized.replace(/:/g, "").replace(/[/.]/g, "-");
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

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code" as const;
  readonly eventSource = "hooks" as const;
  private readonly binary: string;
  private readonly homeDir: string;
  private readonly fullScanMaxBytes: number;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.homeDir = options.homeDir ?? homedir();
    this.fullScanMaxBytes = options.fullScanMaxBytes ?? DEFAULT_FULL_SCAN_MAX_BYTES;
  }

  async doctor(): Promise<DoctorCheck[]> {
    try {
      const { stdout } = await execFileAsync(this.binary, ["--version"], { timeout: 5_000 });
      return [{ name: "claude", ok: true, detail: stdout.trim() || "installed" }];
    } catch {
      return [
        {
          name: "claude",
          ok: false,
          detail: `\`${this.binary}\` not found on PATH. Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup`,
        },
      ];
    }
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

  async listPastSessions(cwd: string): Promise<SessionSummary[]> {
    const projectDir = join(this.homeDir, ".claude", "projects", encodeProjectPath(cwd));
    let entries: string[];
    try {
      entries = await readdir(projectDir);
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projectDir, file);
      const agentSessionId = basename(file, ".jsonl");
      const fileStat = await stat(filePath).catch(() => undefined);
      if (!fileStat) continue;
      const { head, tail, messageCount } = await scanTranscript(
        filePath,
        fileStat.size,
        this.fullScanMaxBytes,
      );
      if (head.length === 0 && tail.length === 0) continue;
      summaries.push({
        agentSessionId,
        harness: "claude-code",
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
