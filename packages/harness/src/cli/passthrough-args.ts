/**
 * Pre-scan for the CLI passthrough grammar. bin.ts calls parsePassthroughArgv
 * BEFORE its existing web-mode parseArgs; a null return means "not passthrough
 * mode" and the argv falls through to the web-UI path completely unchanged.
 *
 * Grammar (exactly one form — the `--` separator is mandatory):
 *
 *   sapiom-harness [harness-flags] -- <agent> [child-args...]
 *
 * The token right after the first `--` must be a known agent: `claude` |
 * `claude-code` (both → kind "claude-code") or `codex` (→ kind "codex").
 * Everything after the agent goes to the child VERBATIM — later `--` tokens
 * and harness-looking flags (`--no-auth`, `--port`, ...) included; there they
 * belong to the child. A `--` NOT followed by a known agent is an error, never
 * a silent fallthrough.
 *
 * Tokens before the `--` must be the passthrough harness flags (`--no-auth`,
 * `--no-telemetry`) and nothing else: web-UI-mode flags (`--port`, `--no-open`,
 * `--no-session`, `--dev`), unknown flags, and positionals are each a clear
 * error rather than a silent misparse.
 *
 * Without any `--`, the argv is never passthrough mode — `sapiom-harness
 * claude` is the web-UI mode's dir positional. bin.ts points agent-named,
 * nonexistent dirs at the `--` form via suggestPassthroughHint.
 */

import type { HarnessKind } from "../shared/types.js";

const AGENT_TOKENS = new Map<string, HarnessKind>([
  ["claude", "claude-code"],
  ["claude-code", "claude-code"],
  ["codex", "codex"],
]);

/** The only harness flags accepted before the `--` in passthrough mode. */
const PASSTHROUGH_FLAGS = ["--no-auth", "--no-telemetry"];

/** Web-UI-mode flags — rejected before a `--` with a pointed message. */
const WEB_ONLY_FLAGS = new Set(["--port", "--no-open", "--no-session", "--dev"]);

export interface PassthroughInvocation {
  /** Which harness adapter to launch. */
  kind: HarnessKind;
  /** The literal agent token the user typed (for messages: `claude` vs `claude-code`). */
  agent: string;
  /** Verbatim child argv (everything after the agent token). */
  agentArgs: string[];
  noAuth: boolean;
  noTelemetry: boolean;
}

/**
 * Returns the parsed passthrough invocation, or null when the argv contains
 * no `--` (the web-UI path owns it — including argv like `claude` or
 * `codex --foo`, which are web-mode dir positionals now). Throws on a
 * malformed passthrough invocation: a `--` not followed by a known agent, or
 * anything before the `--` that isn't a known passthrough harness flag.
 */
export function parsePassthroughArgv(argv: string[]): PassthroughInvocation | null {
  const separator = argv.indexOf("--");
  if (separator === -1) return null; // No `--` anywhere: plain web mode.

  // The token after `--` must be a known agent — `--` claims the argv for
  // passthrough mode, so a non-agent there is an error, not web fallthrough.
  const agent = argv[separator + 1];
  const kind = agent === undefined ? undefined : AGENT_TOKENS.get(agent);
  if (agent === undefined || kind === undefined) {
    throw new Error(
      `Expected an agent after '--' (valid agents: ${[...AGENT_TOKENS.keys()].join(", ")})` +
        (agent === undefined ? "" : `, got: ${agent}`),
    );
  }

  // Tokens before the `--` must be ONLY the passthrough harness flags — a
  // typo'd or misplaced flag silently ignored (or silently booting the web
  // UI) would be far harder to spot than this error.
  let noAuth = false;
  let noTelemetry = false;
  for (const token of argv.slice(0, separator)) {
    if (token === "--no-auth") {
      noAuth = true;
    } else if (token === "--no-telemetry") {
      noTelemetry = true;
    } else if (WEB_ONLY_FLAGS.has(token)) {
      throw new Error(
        `${token} is not supported in passthrough mode. ` +
          `To pass it to ${agent} itself, put it after the agent: sapiom-harness -- ${agent} ${token} ...`,
      );
    } else if (token.startsWith("-")) {
      throw new Error(
        `Unknown harness flag before '--': ${token} (valid: ${PASSTHROUGH_FLAGS.join(", ")}). ` +
          `Flags for ${agent} itself go after the agent: sapiom-harness -- ${agent} ${token} ...`,
      );
    } else {
      throw new Error(
        `Unexpected argument before '--': ${token}. ` +
          `Passthrough mode is: sapiom-harness [${PASSTHROUGH_FLAGS.join(" | ")}] -- <agent> [args...]`,
      );
    }
  }

  return { kind, agent, agentArgs: argv.slice(separator + 2), noAuth, noTelemetry };
}

/**
 * The web-mode dir positional shares its spot with what LOOKS like a
 * passthrough invocation missing its `--` (`sapiom-harness claude`). When the
 * positional names a known agent, returns the one-line "did you mean" pointer
 * bin.ts appends if that directory doesn't exist; null for anything else.
 */
export function suggestPassthroughHint(positional: string): string | null {
  if (!AGENT_TOKENS.has(positional)) return null;
  return `did you mean: sapiom-harness -- ${positional} [args...]?`;
}
