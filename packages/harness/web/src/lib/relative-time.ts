/**
 * Observation-time labels. RunView carries no server timestamps, so the only
 * honest time the Studio can show for a run is when IT observed the
 * execution.started announcement (ObservedRun.observedAt). Labels are coarse
 * on purpose: a client wall-clock observation is not a server truth, and
 * fake precision ("2m 13s ago") would claim one.
 */
export function relativeTimeLabel(observedAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - observedAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
