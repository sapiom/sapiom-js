/**
 * Detect (and decide whether to repair) a broken app-managed Claude Code
 * install at boot.
 *
 * Why this exists: doctor's presence check shells `where`, which happily finds
 * `claude.CMD` — but the shim's TARGET can be gone. Shipped case: Claude
 * Code's own native auto-updater renamed the running `claude.exe` to
 * `claude.exe.old.<ms-epoch>` inside OUR npm prefix and failed to write the
 * replacement, after which every session spawn on the machine failed while
 * doctor kept reporting the agent present. `resolveSpawnTarget` is the real
 * oracle — it resolves the shim to what CreateProcess would actually run — so
 * boot asks it directly and re-runs the (idempotent) npm install when the
 * broken binary is ours to fix.
 *
 * Pure decision logic, dependency-injected (no `electron` import) so the
 * Windows behavior is provable from the POSIX vitest tier — same pattern as
 * update-policy.ts.
 */

export interface AgentRepairDeps {
  platform: NodeJS.Platform;
  /** Does `<npm prefix>/node_modules/@anthropic-ai/claude-code` exist — i.e. is the install ours? */
  managedInstallExists: boolean;
  /** Throws (SpawnTargetError) when the agent cannot actually be spawned; returns on success. */
  checkSpawn: () => void;
}

export interface AgentRepairDecision {
  repair: boolean;
  /** The spawn failure that justified the repair — for the boot log. */
  reason: string | null;
}

export function agentRepairDecision(deps: AgentRepairDeps): AgentRepairDecision {
  // POSIX resolveSpawnTarget is a deliberate passthrough (no filesystem
  // check), so there is nothing provable to key a repair on — and the
  // .cmd-shim failure class this exists for is Windows-only anyway.
  if (deps.platform !== "win32") return { repair: false, reason: null };
  try {
    deps.checkSpawn();
    return { repair: false, reason: null };
  } catch (err) {
    // A broken agent the app does NOT own is not ours to reinstall over —
    // the typed session-create error carries the remedy to the user instead.
    if (!deps.managedInstallExists) return { repair: false, reason: null };
    return { repair: true, reason: err instanceof Error ? err.message : String(err) };
  }
}
