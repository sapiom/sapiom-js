/**
 * What to do when the single-instance lock is already held.
 *
 * Pure, because the interesting case is invisible in production and used to be
 * invisible in CI too: `--smoke` called `app.quit()` when it lost the lock,
 * which exits **0**. A packaging gate whose whole job is "did this artifact
 * actually work?" would then report success having run **zero checks** — the
 * worst failure mode a verification harness can have, because it is
 * indistinguishable from a green run in the log. (Found by auditing the smoke
 * harness itself, after it had already been used to sign off a release.)
 *
 * A real launch still just focuses the running window and quits quietly; only
 * the smoke path turns a lost lock into a loud failure.
 */

export type InstanceLockAction =
  /** Boot normally — we own the lock. */
  | { action: "boot" }
  /** A second real launch: hand off to the running instance, exit 0. */
  | { action: "quit" }
  /** A smoke run that cannot verify anything: exit non-zero, loudly. */
  | { action: "fail"; exitCode: number; message: string };

export function resolveInstanceLockAction(input: {
  gotLock: boolean;
  smokeMode: boolean;
}): InstanceLockAction {
  if (input.gotLock) return { action: "boot" };
  if (!input.smokeMode) return { action: "quit" };
  return {
    action: "fail",
    exitCode: 1,
    // Phrased as a smoke report line so it lands in the same grep as every other
    // result, and names the fix — a stale instance is the usual cause locally.
    message:
      "[smoke] FAILED — another Sapiom instance holds the single-instance lock, so nothing was verified. " +
      "Quit the running app (or kill the stale process) and re-run.",
  };
}
