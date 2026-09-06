import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DoctorCheck, HarnessKind } from "../shared/types.js";
import { MIN_CLAUDE_CODE_VERSION, isClaudeVersionSupported } from "../core/adapters/claude-code.js";

const execFileAsync = promisify(execFile);

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(process.platform === "win32" ? "where" : "which", [
      bin,
      // windowsHide: a console child of the console-less desktop host would
      // otherwise open a visible window (no-op on POSIX and in a real terminal).
    ], { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL" });
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

async function version(bin: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL" });
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

function nodeCheck(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  const ok = major >= 20;
  return {
    name: "node",
    ok,
    detail: ok ? `v${process.versions.node}` : `v${process.versions.node} (need >= 20)`,
  };
}

async function binaryCheck(
  name: string,
  bin: string,
  versionArgs: string[],
  notFoundDetail: string,
  /**
   * Optional version gate. Receives the reported version line (or null when
   * `--version` produced nothing) and returns an error detail when the binary
   * is present but too old to use, or null when it is acceptable. Keeps the
   * "how old is too old" policy with the caller that knows the flags it sends,
   * so this stays a generic presence-plus-version check.
   */
  versionGate?: (versionLine: string | null) => string | null,
): Promise<DoctorCheck> {
  const found = await which(bin);
  if (!found) return { name, ok: false, detail: notFoundDetail };
  const v = await version(bin, versionArgs);
  const gateError = versionGate?.(v);
  if (gateError) return { name, ok: false, detail: gateError };
  return { name, ok: true, detail: v ?? found };
}

/** Exact remedies surfaced in doctor output and the fatal-exit message —
 *  kept as named constants so bin.ts's messaging can't drift from what
 *  doctor.ts itself tells the user to run. */
export const CLAUDE_INSTALL_COMMAND = "npm i -g @anthropic-ai/claude-code";
export const CODEX_INSTALL_COMMAND = "npm i -g @openai/codex";

/**
 * Node is a hard requirement. Neither coding agent is individually required —
 * the harness runs with whichever of claude/codex is on PATH — but at least
 * one of them must be, or there's nothing to launch.
 */
export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
  /** Harness kinds with a working binary on PATH, in default-preference order
   *  (claude-code first). Empty only when `ok` is false. */
  availableHarnesses: HarnessKind[];
}

export async function runDoctor(): Promise<DoctorReport> {
  const node = nodeCheck();
  const [claude, codex, git] = await Promise.all([
    binaryCheck(
      "claude",
      "claude",
      ["--version"],
      `not found on PATH — install: ${CLAUDE_INSTALL_COMMAND}`,
      // A claude older than the flags we inject exit-1s every session before it
      // can establish a session id. Report it as unavailable so the desktop
      // host installs a current one and the CLI shows an upgrade remedy, rather
      // than letting a green check hide a binary that crash-loops on launch.
      (v) =>
        isClaudeVersionSupported(v)
          ? null
          : `${v ?? "unknown version"} is too old — need >= ${MIN_CLAUDE_CODE_VERSION}; upgrade: ${CLAUDE_INSTALL_COMMAND}`,
    ),
    binaryCheck("codex", "codex", ["--version"], `not found on PATH — install: ${CODEX_INSTALL_COMMAND}`),
    binaryCheck("git", "git", ["--version"], "not found on PATH"),
  ]);

  const availableHarnesses: HarnessKind[] = [
    ...(claude.ok ? (["claude-code"] as const) : []),
    ...(codex.ok ? (["codex"] as const) : []),
  ];

  const checks = [node, claude, codex, git];
  return { checks, ok: node.ok && availableHarnesses.length > 0, availableHarnesses };
}

/** First available harness in preference order, for callers that need a
 *  single default (e.g. the auto-created boot session). Only falls back to
 *  "claude-code" when the report itself is empty — main() already refuses to
 *  proceed past a report with no available harnesses, so real callers never
 *  hit that fallback. */
export function pickDefaultHarness(report: DoctorReport): HarnessKind {
  return report.availableHarnesses[0] ?? "claude-code";
}

export function printDoctorReport(report: DoctorReport): void {
  console.log("Doctor:");
  for (const check of report.checks) {
    const mark = check.ok ? "✓" : "✗";
    console.log(`  ${mark} ${check.name.padEnd(8)} ${check.detail}`);
  }
}
