import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenCodeShutdownError,
  startOpenCodeServer,
  type OpenCodeServer,
} from "@sapiom/opencode";

/** Exercise the same native launch, plugin, authentication and cleanup as Assistant. */
export async function checkOpenCodeRuntime(): Promise<string> {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "studio-opencode-smoke-"),
  );
  const runtimes: OpenCodeServer[] = [];
  let startupFailure: unknown;
  try {
    const sessions = new Set<string>();
    for (const name of ["first", "second"]) {
      // No command override: the production resolver must find the PACKAGED
      // executable. No provider call or account credential is needed to open.
      const runtime = await startOpenCodeServer({
        cwd: root,
        stateRoot: join(root, name),
        config: {},
      });
      runtimes.push(runtime);
      const session = await runtime.fetchJson<{ id: string }>("/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!session.id || sessions.has(session.id))
        throw new Error(
          "Packaged OpenCode did not create independent sessions",
        );
      sessions.add(session.id);
      // Opening the second runtime must leave the first one usable.
      for (const active of runtimes) {
        const health = await active.fetchJson<{ healthy: boolean }>(
          "/global/health",
        );
        if (!health.healthy) throw new Error("Packaged OpenCode is unhealthy");
      }
    }
    return "two packaged Assistant runtimes opened independent sessions and shut down";
  } catch (error) {
    startupFailure = error;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled(
      runtimes.map((runtime) => runtime.close()),
    );
    const failed = cleanup.find((result) => result.status === "rejected");
    // Retain state when process ownership/cleanup is uncertain, matching the
    // production host; a failed cleanup must fail this release check.
    if (failed?.status === "rejected") throw failed.reason;
    if (!(startupFailure instanceof OpenCodeShutdownError))
      rmSync(root, { recursive: true, force: true });
  }
}
