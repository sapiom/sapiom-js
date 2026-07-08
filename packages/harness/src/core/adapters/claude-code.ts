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

const execFileAsync = promisify(execFile);

/** Bytes read from the tail of a transcript file. Files can be 100MB+; the
 * summary/title we need is always near the end. */
const TRANSCRIPT_TAIL_BYTES = 65_536;

export interface ClaudeCodeAdapterOptions {
  /** Overridable for tests (e.g. spawn `bash` instead of a real, auth-gated `claude`). */
  binary?: string;
  /** Overridable for tests. Defaults to the real home directory. */
  homeDir?: string;
}

interface TranscriptEntry {
  type?: string;
  summary?: string;
  message?: { role?: string; content?: unknown };
}

/**
 * Claude Code stores transcripts at `~/.claude/projects/<encoded-cwd>/*.jsonl`.
 * The encoding strips the leading `/` and replaces `/` and `.` with `-`.
 * If Claude Code changes this scheme, discovery silently returns no history
 * (listPastSessions degrades to an empty list, not an error).
 */
function encodeProjectPath(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  return normalized.replace(/:/g, "").replace(/[/.]/g, "-");
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

/** Read only the tail of a (possibly huge) JSONL transcript file. */
async function readTranscriptTail(
  filePath: string,
  maxBytes = TRANSCRIPT_TAIL_BYTES,
): Promise<TranscriptEntry[]> {
  let content: string;
  let startedMidFile = false;
  try {
    const { size } = await stat(filePath);
    if (size <= maxBytes) {
      content = await readFile(filePath, "utf8");
    } else {
      const offset = size - maxBytes;
      const handle = await open(filePath, "r");
      try {
        const buffer = Buffer.allocUnsafe(maxBytes);
        await handle.read(buffer, 0, maxBytes, offset);
        content = buffer.toString("utf8");
        startedMidFile = true;
      } finally {
        await handle.close();
      }
    }
  } catch {
    return [];
  }

  // A tail read may start mid-line; drop the (possibly truncated) first line.
  const firstNewline = content.indexOf("\n");
  const safeContent = startedMidFile && firstNewline >= 0 ? content.slice(firstNewline + 1) : content;

  const entries: TranscriptEntry[] = [];
  for (const line of safeContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        entries.push(parsed as TranscriptEntry);
      }
    } catch {
      // Skip malformed/truncated lines (expected at the start of a tail read).
    }
  }
  return entries;
}

function extractTitle(entries: TranscriptEntry[], fallback: string): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "summary" && typeof entry.summary === "string" && entry.summary.trim()) {
      return entry.summary.trim();
    }
  }
  for (const entry of entries) {
    if (entry?.type !== "user") continue;
    const text = extractTextFromContent(entry.message?.content)?.trim();
    if (text) return text.length > 120 ? `${text.slice(0, 120)}...` : text;
  }
  return fallback;
}

function buildConfigArgs(opts: LaunchOpts): string[] {
  const args: string[] = [];
  if (opts.settingsFile) args.push("--settings", opts.settingsFile);
  if (opts.mcpConfigFile) args.push("--mcp-config", opts.mcpConfigFile);
  return args;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code" as const;
  readonly eventSource = "hooks" as const;
  private readonly binary: string;
  private readonly homeDir: string;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.homeDir = options.homeDir ?? homedir();
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
      const transcript = await readTranscriptTail(filePath);
      if (transcript.length === 0) continue;
      const fileStat = await stat(filePath).catch(() => undefined);
      const lastActiveAt = fileStat ? fileStat.mtime.toISOString() : new Date(0).toISOString();
      summaries.push({
        agentSessionId,
        harness: "claude-code",
        cwd,
        title: extractTitle(transcript, agentSessionId),
        lastActiveAt,
        source: "transcript",
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
