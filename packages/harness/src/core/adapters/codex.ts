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
import { open, readdir, stat } from "node:fs/promises";
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

/** Bytes read from the head of a rollout file to find its session_meta line
 * and an early title candidate. Unlike Claude's transcripts (where a summary
 * lands near the end), Codex has no end-of-session summary line, so the
 * earliest user message is the best available title — and it's always near
 * the start of the file. */
const ROLLOUT_HEAD_BYTES = 65_536;
const MAX_SCAN_DEPTH = 4; // ~/.codex/sessions/YYYY/MM/DD/*.jsonl

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
  private readonly binary: string;
  private readonly homeDir: string;

  constructor(options: CodexAdapterOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.homeDir = options.homeDir ?? homedir();
  }

  async doctor(): Promise<DoctorCheck[]> {
    try {
      const { stdout } = await execFileAsync(this.binary, ["--version"], { timeout: 5_000 });
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

  async listPastSessions(cwd: string): Promise<SessionSummary[]> {
    const root = join(this.homeDir, ".codex", "sessions");
    const files = await collectRolloutFiles(root);

    const summaries: SessionSummary[] = [];
    for (const filePath of files) {
      const meta = await readSessionMeta(filePath);
      if (!meta || meta.cwd !== cwd) continue;

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
  const args = ["-c", "check_for_update_on_startup=false"];
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
