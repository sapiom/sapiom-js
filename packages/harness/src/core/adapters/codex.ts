/**
 * codex adapter — honest stub. `doctor()` reports whether the `codex` CLI is
 * on PATH; launch/resume are not implemented yet (transcript-tail event
 * source and rollout-file discovery land in a follow-up workstream).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DoctorCheck, HarnessAdapter, LaunchOpts, SessionSummary, SpawnSpec } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

export interface CodexAdapterOptions {
  binary?: string;
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex" as const;
  readonly eventSource = "transcript-tail" as const;
  private readonly binary: string;

  constructor(options: CodexAdapterOptions = {}) {
    this.binary = options.binary ?? "codex";
  }

  async doctor(): Promise<DoctorCheck[]> {
    try {
      await execFileAsync(this.binary, ["--version"], { timeout: 5_000 });
      return [{ name: "codex", ok: true, detail: "installed (Codex support coming soon)" }];
    } catch {
      return [
        {
          name: "codex",
          ok: false,
          detail: `\`${this.binary}\` not found on PATH. Codex support is coming soon.`,
        },
      ];
    }
  }

  launch(_opts: LaunchOpts): SpawnSpec {
    throw new Error("codex support coming soon");
  }

  resume(_agentSessionId: string, _opts: LaunchOpts): SpawnSpec {
    throw new Error("codex support coming soon");
  }

  async listPastSessions(_cwd: string): Promise<SessionSummary[]> {
    return [];
  }
}

export function createCodexAdapter(options?: CodexAdapterOptions): HarnessAdapter {
  return new CodexAdapter(options);
}
