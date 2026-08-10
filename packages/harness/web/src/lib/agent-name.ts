/**
 * The name to SHOW for an agent in the rail and other chrome.
 *
 * The registry's `WorkflowInfo.name` is the cloned project's `package.json`
 * name — a scoped, often long string like `@sapiom/example-newsletter-autopilot`
 * that truncates in the narrow rail. Strip the npm scope and a leading
 * `example-` (the gallery templates' naming convention) so the row reads as the
 * short, human name (`newsletter-autopilot`).
 *
 * DISPLAY ONLY. The raw `name` still keys testids (`workflow-${name}`) and any
 * lookups — callers pass `workflow.name` to those unchanged. Falls back to the
 * raw name if stripping would leave nothing (e.g. a bare scope).
 */
export function displayAgentName(name: string): string {
  const unscoped = name.replace(/^@[^/]+\//, "");
  const cleaned = unscoped.replace(/^example-/, "").trim();
  return cleaned || name;
}
