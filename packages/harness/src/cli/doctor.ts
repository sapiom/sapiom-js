import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DoctorCheck } from "../shared/types.js";

const execFileAsync = promisify(execFile);

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(process.platform === "win32" ? "where" : "which", [
      bin,
    ]);
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

async function version(bin: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args);
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
): Promise<DoctorCheck> {
  const found = await which(bin);
  if (!found) return { name, ok: false, detail: notFoundDetail };
  const v = await version(bin, versionArgs);
  return { name, ok: true, detail: v ?? found };
}

/** Hard requirements (node, claude) vs. optional ones (codex, git). */
export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export async function runDoctor(): Promise<DoctorReport> {
  const node = nodeCheck();
  const [claude, codex, git] = await Promise.all([
    binaryCheck(
      "claude",
      "claude",
      ["--version"],
      "not found on PATH — install Claude Code: https://docs.claude.com/claude-code",
    ),
    binaryCheck(
      "codex",
      "codex",
      ["--version"],
      "not found on PATH (optional — the Codex harness is unavailable)",
    ),
    binaryCheck("git", "git", ["--version"], "not found on PATH"),
  ]);

  const checks = [node, claude, codex, git];
  return { checks, ok: node.ok && claude.ok };
}

export function printDoctorReport(report: DoctorReport): void {
  console.log("Doctor:");
  for (const check of report.checks) {
    const mark = check.ok ? "✓" : "✗";
    console.log(`  ${mark} ${check.name.padEnd(8)} ${check.detail}`);
  }
}
