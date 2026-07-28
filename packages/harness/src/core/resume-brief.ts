/**
 * The "portable continue" brief: a bounded markdown reconstruction of a prior
 * session, rendered from the SessionRecord our own events already produce (see
 * core/session-record.ts).
 *
 * Why this exists rather than a vendor resume: `claude --resume` / `codex
 * resume` only work when that agent, on this machine, still holds that
 * conversation. H1 (SAP-2057) made us stop pretending otherwise; this is the
 * other half — for every row where the agent does NOT hold it, start a fresh
 * session seeded with what we recorded. Because the input is our normalized
 * record and the output is plain text, the same code path serves claude-code
 * (`--append-system-prompt`) and codex (`developer_instructions`), and would
 * serve a harness with no prompt flag at all via post-ready injection.
 *
 * HONESTY IS THE PRODUCT HERE. A brief that reads like restored memory is
 * worse than no brief: the agent will assert a file's contents or a command's
 * outcome it never saw. So the header says outright that this is a
 * reconstruction, `record.limitations` are spelled out, and every omission
 * (dropped turns, clamped text, capped file lists) is stated in the text
 * rather than silently applied.
 *
 * BUDGET. The brief is capped at `maxTokens` (default
 * {@link RESUME_BRIEF_DEFAULT_MAX_TOKENS}), estimated at
 * {@link CHARS_PER_TOKEN} characters per token — deliberately a crude
 * estimator, since the consumer is a system prompt with room to spare, not a
 * hard API limit, and a tokenizer dependency here would have to be right for
 * two different vendors' tokenizers anyway. What gets squeezed, in order:
 *
 *   1. turns, oldest-first — the newest are the ones that explain what is in
 *      flight right now, and an old turn is the most verbose thing here per
 *      unit of usefulness;
 *   2. the derived digests (files written, commands run). They go AFTER turns,
 *      not before, because they are hard-capped ({@link MAX_FILES} /
 *      {@link MAX_COMMANDS}) at a few hundred tokens for a whole session,
 *      where each turn costs a comparable amount on its own — trading a
 *      whole-session view for one more ancient turn is a bad deal. They can
 *      also be recovered by looking at the repository, so this only bites
 *      once every turn is already gone;
 *   3. only then the rolling summary, tail-clamped. It is squeezed last
 *      because it is the one section that is a lossy fold of turns already
 *      dropped in step 1: cutting it loses history nothing else carries.
 *
 * The honesty header and the identity block are never dropped — a brief
 * without them is a lie, not a shorter brief — so they act as a floor of
 * roughly {@link RESUME_BRIEF_MIN_TOKENS} tokens that a smaller `maxTokens`
 * cannot squeeze below.
 */

import * as path from "node:path";

import type {
  SessionRecord,
  SessionRecordLimitation,
  SessionRecordToolCall,
  SessionRecordTurn,
} from "../shared/types.js";

/** Default token ceiling for a brief — see the module header on the estimate. */
export const RESUME_BRIEF_DEFAULT_MAX_TOKENS = 6_000;
/** Turns considered before budgeting; the budget may keep fewer, never more. */
export const RESUME_BRIEF_DEFAULT_MAX_TURNS = 12;
/**
 * Characters per token. Roughly right for English prose and code across both
 * vendors' tokenizers, and biased the safe way: real text averages slightly
 * more than 4 chars/token, so this over-counts and lands under the ceiling.
 */
export const CHARS_PER_TOKEN = 4;
/**
 * Floor the budget can never squeeze below — the honesty header plus the
 * identity block. Approximate (it moves with the header's wording); it exists
 * so callers can reason about "what does maxTokens: 200 even mean" rather than
 * as an assertion about exact size.
 */
export const RESUME_BRIEF_MIN_TOKENS = 400;

/** Per-turn clamps, so one pathological prompt can't consume the whole budget. */
const MAX_PROMPT_CHARS = 1_200;
const MAX_ASSISTANT_CHARS = 1_200;
/** How much of a tool call's target (path or command) to show. */
const MAX_TOOL_TARGET_CHARS = 80;
/** Tool calls listed per turn before the rest are counted rather than named. */
const MAX_TOOLS_PER_TURN = 12;
/** Entries in the derived digests. */
const MAX_FILES = 30;
const MAX_COMMANDS = 10;
const MAX_COMMAND_CHARS = 120;

/** The marker `truncateForPayload` (core/collector/normalizer.ts) leaves. */
const CLAMP_MARKER = "…[truncated]";

/** The workflow the prior session was bound to, resolved by the caller against
 *  the live workflow registry (the record itself has no binding). */
export interface ResumeBriefWorkflow {
  name: string;
  path: string;
  definitionId: number | null;
}

export interface BuildResumeBriefOptions {
  /** Display title of the prior session, when a history row knew one. */
  title?: string | null;
  /** Git branch the prior session was last on, when a history row knew one. */
  gitBranch?: string | null;
  /** The prior session's bound workflow. */
  workflow?: ResumeBriefWorkflow | null;
  /**
   * The rolling summary (`<generated>/<sessionId>/summary.md`) when one was
   * ever produced. Absent, the brief degrades to the last N turns — which is
   * the normal case, since the summary is opt-in (see core/rolling-summary.ts).
   */
  summary?: string | null;
  /** Token ceiling. Default {@link RESUME_BRIEF_DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
  /** Newest turns considered. Default {@link RESUME_BRIEF_DEFAULT_MAX_TURNS}. */
  maxTurns?: number;
}

/** The crude char-count estimate the budget is enforced against. */
export function estimateBriefTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Clamp `text` to `maxChars`, marking the cut so nothing reads as complete
 *  when it isn't. */
function clamp(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}${CLAMP_MARKER}`;
}

/**
 * The tool's target as a human would name it: the file it edited, the command
 * it ran, or — failing both — a clamped slice of the raw input.
 *
 * `toolInput` is a string on the wire for both harnesses: claude-code's
 * normalizer stores `JSON.stringify(tool_input)` and codex's tailer stores the
 * function call's raw `arguments`, so a JSON parse covers both and a plain
 * string (an untruncated free-text argument) falls through to the raw slice.
 * Never throws on malformed input — a brief must render from whatever was
 * recorded, including a payload the collector truncated mid-JSON.
 */
export function describeToolTarget(call: SessionRecordToolCall, cwd: string | null): string | null {
  const parsed = parseToolInput(call.input);
  if (parsed) {
    const filePath = firstString(parsed, ["file_path", "filePath", "notebook_path", "path"]);
    if (filePath) return clamp(displayPath(filePath, cwd), MAX_TOOL_TARGET_CHARS);
    const command = readCommand(parsed);
    if (command) return clamp(command, MAX_TOOL_TARGET_CHARS);
  }
  if (!call.input) return null;
  // No structure to read — show a slice of what was recorded rather than
  // nothing, on one line so a turn's tool list stays scannable.
  return clamp(call.input.replace(/\s+/g, " "), MAX_TOOL_TARGET_CHARS);
}

function parseToolInput(input: string | null): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** claude-code's Bash carries `command` as a string; codex's shell tool carries
 *  it as an argv array (`["bash", "-lc", "…"]`). Both read as one line here. */
function readCommand(source: Record<string, unknown>): string | null {
  const command = source.command;
  if (typeof command === "string" && command.length > 0) return command.replace(/\s+/g, " ").trim();
  if (Array.isArray(command)) {
    const joined = command.filter((part): part is string => typeof part === "string").join(" ").trim();
    return joined.length > 0 ? joined.replace(/\s+/g, " ") : null;
  }
  return null;
}

/** Paths under the session's cwd read far better relative; anything else (or a
 *  record with no recorded cwd) stays absolute so it's never ambiguous. */
function displayPath(filePath: string, cwd: string | null): string {
  if (!cwd || !path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

/** Tools whose input names a file the session wrote to. Read-only tools are
 *  deliberately excluded: "files touched" that includes everything the agent
 *  merely looked at stops being a signal. */
const WRITE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "update",
  "apply_patch",
  "str_replace_editor",
]);

const SHELL_TOOL_NAMES = new Set(["bash", "shell", "run_terminal_cmd", "local_shell"]);

interface DerivedDigests {
  /** Files written, most-recently-touched first, with their touch counts. */
  files: Array<{ display: string; count: number }>;
  /** Total distinct files, which may exceed `files.length` after the cap. */
  totalFiles: number;
  /** Distinct shell commands, most recent first. */
  commands: string[];
  totalCommands: number;
}

/**
 * Files touched and commands run, derived from `tool.call` inputs. Exported
 * for tests and because the same derivation is worth reusing anywhere that
 * needs "what did this session actually do to the tree".
 */
export function deriveDigests(record: SessionRecord): DerivedDigests {
  const fileCounts = new Map<string, number>();
  const commands: string[] = [];
  const seenCommands = new Set<string>();

  for (const turn of record.turns) {
    for (const call of turn.toolCalls) {
      const name = (call.name ?? "").toLowerCase();
      const parsed = parseToolInput(call.input);
      if (WRITE_TOOL_NAMES.has(name)) {
        const filePath = parsed
          ? firstString(parsed, ["file_path", "filePath", "notebook_path", "path"])
          : null;
        if (filePath) {
          const display = displayPath(filePath, record.cwd);
          fileCounts.set(display, (fileCounts.get(display) ?? 0) + 1);
        }
      } else if (SHELL_TOOL_NAMES.has(name)) {
        const command = parsed ? readCommand(parsed) : null;
        if (command && !seenCommands.has(command)) {
          seenCommands.add(command);
          commands.push(clamp(command, MAX_COMMAND_CHARS));
        }
      }
    }
  }

  // Insertion order is chronological; both digests read newest-first, which is
  // what a reader scanning for "where did this leave off" wants.
  const files = [...fileCounts.entries()].reverse().map(([display, count]) => ({ display, count }));
  return {
    files: files.slice(0, MAX_FILES),
    totalFiles: files.length,
    commands: commands.reverse().slice(0, MAX_COMMANDS),
    totalCommands: commands.length,
  };
}

/** Plain-language wording for each machine-readable gap on the record.
 *  Addressed to the agent reading the brief, so it says what to do about the
 *  gap rather than merely naming it — the web view (web/src/lib/
 *  session-record-view.ts) words the same codes for a human reader. */
const LIMITATION_PROSE: Record<SessionRecordLimitation, string> = {
  "truncated-tool-output":
    "Tool output was size-capped when recorded. Any command result quoted below may be cut off — re-run it rather than trusting the excerpt.",
  "assistant-narration-gap":
    "Only the final assistant message of each turn was recorded. Whatever was said between tool calls — including reasoning for a change — is missing.",
  "missing-assistant-text":
    "At least one turn has no assistant text at all (Codex records none). Those turns show prompts and tool calls only.",
  "incomplete-final-turn":
    "The last turn never completed — the session ended mid-turn, so its work may be half-applied.",
  "compacted-archive":
    "This brief was built from the session's archived copy, whose tool inputs and results are clipped to keep it bounded. The conversation is whole, but any payload quoted below is an excerpt — re-read the file or re-run the command rather than trusting it.",
  "dropped-early-turns":
    "The archived copy had room only for the most recent turns; earlier ones are gone. Treat what follows as the tail of a longer session — ask before assuming why something earlier was done.",
};

function renderTurn(turn: SessionRecordTurn, cwd: string | null): string {
  const lines: string[] = [];
  const when = turn.promptAt ?? turn.completedAt;
  lines.push(`### Turn ${turn.index}${when ? ` · ${when}` : ""}${turn.incomplete ? " · never completed" : ""}`);

  if (turn.prompt !== null) {
    lines.push("", "**Prompt:**", "", blockquote(clamp(turn.prompt, MAX_PROMPT_CHARS)));
  } else {
    lines.push("", "**Prompt:** _not recorded — our recording started mid-turn, or the agent started this turn itself._");
  }

  if (turn.toolCalls.length > 0) {
    const shown = turn.toolCalls.slice(0, MAX_TOOLS_PER_TURN).map((call) => {
      const target = describeToolTarget(call, cwd);
      return `\`${call.name ?? "unknown tool"}\`${target ? ` ${target}` : ""}`;
    });
    const overflow = turn.toolCalls.length - shown.length;
    lines.push("", `**Tools:** ${shown.join(" · ")}${overflow > 0 ? ` · …and ${overflow} more` : ""}`);
  }

  if (turn.assistantText !== null) {
    lines.push("", "**Reply:**", "", blockquote(clamp(turn.assistantText, MAX_ASSISTANT_CHARS)));
  } else if (!turn.incomplete) {
    lines.push("", "**Reply:** _not recorded._");
  }

  return lines.join("\n");
}

function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * The fixed preamble. Never dropped by the budget: an unlabelled
 * reconstruction is the failure mode this whole feature exists to avoid.
 */
const HONESTY_HEADER = `# Continuing a prior session — reconstruction, not restored context

You are a **fresh session**. The agent that ran the session described below is
gone and none of its context is loaded. What follows was assembled by the
Sapiom Harness from its own recorded events — it is a briefing about that
session, not a replay of it, and it is partial by construction.

Treat every claim here as something a colleague told you, not as something you
remember. Before you rely on any of it — what a file contains, what a command
returned, whether a task was finished — check the current state of the
repository yourself. If the brief and the working tree disagree, the working
tree is right.`;

/**
 * Render a bounded brief for `record`. Pure and synchronous; the caller
 * supplies the rolling summary and any registry-only context (title, branch,
 * bound workflow) it can resolve.
 */
export function buildResumeBrief(
  record: SessionRecord,
  options: BuildResumeBriefOptions = {},
): string {
  const maxTokens = options.maxTokens ?? RESUME_BRIEF_DEFAULT_MAX_TOKENS;
  const maxTurns = options.maxTurns ?? RESUME_BRIEF_DEFAULT_MAX_TURNS;
  const budgetChars = Math.max(0, maxTokens) * CHARS_PER_TOKEN;

  const identity = renderIdentity(record, options);
  // The floor: these two are unconditional, so everything else is budgeted
  // against whatever remains after them.
  const fixed = `${HONESTY_HEADER}\n\n${identity}`;

  const digests = deriveDigests(record);
  const renderedTurns = (maxTurns > 0 ? record.turns.slice(-maxTurns) : []).map((turn) =>
    renderTurn(turn, record.cwd),
  );

  // Mutable knobs, squeezed in the order the module header documents: the
  // derived digests first (recoverable from the tree), then turns oldest-first,
  // then — only if the summary alone still overflows — the summary itself.
  let summaryText = options.summary?.trim() ?? "";
  let keepFiles = true;
  let keepCommands = true;
  let keptTurns = renderedTurns.length;

  const assemble = (): string => {
    const parts = [fixed];
    const summarySection = renderSummary(summaryText);
    if (summarySection) parts.push(summarySection);
    const dropped: string[] = [];
    const filesSection = keepFiles ? renderFiles(digests) : null;
    if (filesSection) parts.push(filesSection);
    else if (!keepFiles && digests.files.length > 0) dropped.push("files written");
    const commandsSection = keepCommands ? renderCommands(digests) : null;
    if (commandsSection) parts.push(commandsSection);
    else if (!keepCommands && digests.commands.length > 0) dropped.push("commands run");

    if (record.turns.length > 0) {
      const heading = ["## Recent turns"];
      const omitted = record.turns.length - keptTurns;
      if (omitted > 0) {
        heading.push(
          "",
          `_The earliest ${omitted} of ${record.turns.length} recorded turns are omitted here to fit the context budget._`,
        );
      }
      if (keptTurns === 0) heading.push("", "_No turns fit the context budget._");
      parts.push(heading.join("\n"));
      parts.push(...renderedTurns.slice(renderedTurns.length - keptTurns));
    }
    if (dropped.length > 0) {
      parts.push(`_Also omitted to fit the context budget: ${dropped.join(", ")}._`);
    }
    return parts.join("\n\n").trimEnd() + "\n";
  };

  const over = (): boolean => assemble().length > budgetChars;

  // 1. Turns, oldest-first.
  while (keptTurns > 0 && over()) keptTurns -= 1;
  // 2. Derived digests, once no turn is left to give. Commands go first — the
  //    shorter list, and the one most cheaply reconstructed from the repo.
  if (over()) keepCommands = false;
  if (over()) keepFiles = false;
  // 3. Last resort. Only reachable when the fixed preamble plus the summary
  //    alone overflow, which means either the summary was produced outside its
  //    own ≤500-word contract or `maxTokens` is below the preamble floor. Each
  //    pass strictly shortens `summaryText`, so this terminates.
  while (summaryText.length > 0 && over()) {
    const overflow = assemble().length - budgetChars;
    summaryText = clamp(summaryText, Math.max(0, summaryText.length - overflow - CLAMP_MARKER.length));
    if (summaryText === CLAMP_MARKER) summaryText = "";
  }

  return assemble();
}

function renderIdentity(record: SessionRecord, options: BuildResumeBriefOptions): string {
  const lines = ["## What the prior session was", ""];
  if (options.title) lines.push(`- **Title:** ${options.title}`);
  lines.push(`- **Directory:** ${record.cwd ?? "not recorded"}`);
  if (options.gitBranch) lines.push(`- **Git branch:** ${options.gitBranch}`);
  lines.push(`- **Agent:** ${record.harness}`);
  if (options.workflow) {
    const { name, path: workflowPath, definitionId } = options.workflow;
    lines.push(
      `- **Bound workflow:** ${name} (\`${workflowPath}\`)${
        definitionId !== null ? ` — definition ${definitionId}` : " — not yet linked to a deployed definition"
      }`,
    );
  } else {
    lines.push("- **Bound workflow:** none");
  }
  const span = [record.startedAt, record.endedAt].filter(Boolean).join(" → ");
  if (span) lines.push(`- **Ran:** ${span}`);
  lines.push(`- **Recorded turns:** ${record.turnCount}`);

  if (record.limitations.length > 0) {
    lines.push("", "**Known gaps in this reconstruction:**", "");
    for (const limitation of record.limitations) lines.push(`- ${LIMITATION_PROSE[limitation]}`);
  }
  return lines.join("\n");
}

function renderSummary(summary: string | null | undefined): string | null {
  const trimmed = summary?.trim();
  if (!trimmed) return null;
  return `## Rolling summary of the prior session\n\n${trimmed}`;
}

function renderFiles(digests: DerivedDigests): string | null {
  if (digests.files.length === 0) return null;
  const lines = ["## Files the prior session wrote to", "", "_Derived from recorded tool calls, newest first._", ""];
  for (const file of digests.files) {
    lines.push(`- \`${file.display}\`${file.count > 1 ? ` (${file.count} edits)` : ""}`);
  }
  if (digests.totalFiles > digests.files.length) {
    lines.push(`- …and ${digests.totalFiles - digests.files.length} more`);
  }
  return lines.join("\n");
}

function renderCommands(digests: DerivedDigests): string | null {
  if (digests.commands.length === 0) return null;
  const lines = ["## Shell commands it ran", "", "_Distinct commands, newest first._", ""];
  for (const command of digests.commands) lines.push(`- \`${command}\``);
  if (digests.totalCommands > digests.commands.length) {
    lines.push(`- …and ${digests.totalCommands - digests.commands.length} more`);
  }
  return lines.join("\n");
}
