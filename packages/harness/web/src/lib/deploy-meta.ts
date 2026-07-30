/**
 * Lightweight persistence for the last successful deploy result.
 * Mirrors the localStorage helper pattern used by run-input helpers —
 * one key per workflow path, tolerant of unavailable/broken storage.
 */

const STORAGE_PREFIX = "sapiom:deploy-meta:";

function storageKey(workflowPath: string): string {
  return STORAGE_PREFIX + encodeURIComponent(workflowPath);
}

export interface DeployMeta {
  buildRunId: string;
  deployedAt: number;
}

export function saveLastDeploy(workflowPath: string, meta: DeployMeta): void {
  try {
    localStorage.setItem(storageKey(workflowPath), JSON.stringify(meta));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — non-fatal.
  }
}

export function loadLastDeploy(workflowPath: string): DeployMeta | null {
  try {
    const raw = localStorage.getItem(storageKey(workflowPath));
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "buildRunId" in parsed &&
      "deployedAt" in parsed &&
      typeof (parsed as DeployMeta).buildRunId === "string" &&
      typeof (parsed as DeployMeta).deployedAt === "number"
    ) {
      return parsed as DeployMeta;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Human-readable relative time label. Coarse buckets on purpose — a
 * client wall-clock timestamp is not a server truth, and fake precision
 * would be misleading.
 *
 * @param ts  The timestamp in ms (e.g. Date.now() at deploy time).
 * @param now Optional override for the current time — pass an explicit value
 *            in tests so assertions are deterministic.
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
