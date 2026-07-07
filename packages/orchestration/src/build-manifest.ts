import { zodToJsonSchema } from "./introspection.js";
import {
  MANIFEST_PROTOCOL,
  type ManifestTransition,
  type AgentManifest,
} from "./manifest.js";
import type { StepDefinition } from "./step.js";
import type { AgentDefinition } from "./agent.js";

/**
 * Generate a AgentManifest from a workflow definition and build metadata.
 *
 * - Walks def.steps; for each step:
 *   - timeoutMs: step.timeoutMs if declared, null otherwise.
 *   - inputSchema: the step's Zod schema converted to JSON Schema if declared,
 *     null otherwise. The generated schema is normalized so it accepts the same
 *     inputs the Zod schema parses: defaulted fields are not forced as required,
 *     and objects are not closed to extra fields.
 *   - transitions: the tagged edge list, read from the step's declared
 *     `next`/`terminal`/`canFail`/`pause` runtime properties (set by
 *     `defineStep`). This is a runtime-value read, exactly like inputSchema —
 *     no type reflection, no AST parsing.
 * - name/entry from def; protocol 1 (locked); sdkVersion/artifact from opts.
 */
export function buildManifest(
  def: AgentDefinition,
  opts: {
    sdkVersion: string;
    artifact: { sha256: string; entryFile: string };
  },
): AgentManifest {
  const steps: Record<
    string,
    {
      timeoutMs: number | null;
      inputSchema: Record<string, unknown> | null;
      transitions: ManifestTransition[];
    }
  > = {};

  for (const [stepName, step] of Object.entries(def.steps)) {
    let inputSchema: Record<string, unknown> | null = null;
    if (step.inputSchema) {
      const raw = zodToJsonSchema(step.inputSchema);
      inputSchema = relaxAdditionalProperties(
        dropDefaultedFromRequired(raw),
      ) as Record<string, unknown>;
    }
    steps[stepName] = {
      timeoutMs: step.timeoutMs ?? null,
      inputSchema,
      transitions: transitionsFor(step),
    };
  }

  return {
    protocol: MANIFEST_PROTOCOL,
    name: def.name,
    entry: def.entry,
    sdkVersion: opts.sdkVersion,
    artifact: opts.artifact,
    steps,
  };
}

/**
 * Derive the tagged transition list from a step's declared capabilities. Order:
 * one `continue` per `next` entry, then `pause`, then `terminate`, then `fail`.
 */
function transitionsFor(step: StepDefinition): ManifestTransition[] {
  const transitions: ManifestTransition[] = [];
  for (const target of step.next ?? []) {
    transitions.push({ kind: "continue", target });
  }
  if (step.pause) {
    transitions.push({
      kind: "pause",
      signal: step.pause.signal,
      resumeStep: step.pause.resumeStep,
    });
  }
  if (step.terminal) transitions.push({ kind: "terminate" });
  if (step.canFail) transitions.push({ kind: "fail" });
  return transitions;
}

// ---------------------------------------------------------------------------
// Graph validation (build-time conformance check — a developer-facing courtesy
// that surfaces malformed graphs early; not an authoritative guarantee).
// ---------------------------------------------------------------------------

export interface GraphValidation {
  /** Build-blocking problems (malformed graph). */
  readonly errors: string[];
  /** Non-blocking smells (unreachable steps, no path to a terminal). */
  readonly warnings: string[];
}

/**
 * Validate a manifest's graph. Errors (build should fail):
 *   - entry step missing;
 *   - a `continue` target that doesn't exist;
 *   - a dead-end step (no transitions at all — can only retry, never progress).
 * Warnings (best-effort):
 *   - steps unreachable from entry;
 *   - steps that cannot reach any `terminate`/`fail` (possible unbounded loop
 *     or a missing terminal). A `pause` counts as a forward edge via resumeStep.
 */
export function validateGraph(manifest: AgentManifest): GraphValidation {
  const errors: string[] = [];
  const names = new Set(Object.keys(manifest.steps));

  if (!names.has(manifest.entry)) {
    errors.push(`entry step '${manifest.entry}' is not in the steps map`);
  }

  // Forward edges (continue targets + pause resumeStep); also records
  // continue-target-missing + dead-end errors as a side effect.
  const forward = buildForwardEdges(manifest, names, errors);

  const warnings: string[] = [];
  if (names.has(manifest.entry)) {
    const reachable = bfs([manifest.entry], forward);
    for (const name of names) {
      if (!reachable.has(name))
        warnings.push(
          `step '${name}' is unreachable from entry '${manifest.entry}'`,
        );
    }
  }
  warnings.push(...terminalReachabilityWarnings(manifest, names, forward));

  return { errors, warnings };
}

/** Throw if the graph has errors; return warnings. Used by the build phase. */
export function assertValidGraph(manifest: AgentManifest): string[] {
  const { errors, warnings } = validateGraph(manifest);
  if (errors.length > 0) {
    throw new Error(
      `Invalid workflow graph for '${manifest.name}':\n  - ${errors.join("\n  - ")}`,
    );
  }
  return warnings;
}

/**
 * Build the forward adjacency map (continue targets + pause resumeStep). Pushes
 * a continue-target-missing error per unknown target and a dead-end error for a
 * step that declares no transitions at all.
 */
function buildForwardEdges(
  manifest: AgentManifest,
  names: Set<string>,
  errors: string[],
): Map<string, Set<string>> {
  const forward = new Map<string, Set<string>>();
  for (const [name, step] of Object.entries(manifest.steps)) {
    const targets = new Set<string>();
    for (const t of step.transitions) {
      if (t.kind === "continue") {
        if (names.has(t.target)) targets.add(t.target);
        else
          errors.push(
            `step '${name}' has a continue target '${t.target}' that is not in the steps map`,
          );
      } else if (t.kind === "pause" && names.has(t.resumeStep)) {
        targets.add(t.resumeStep);
      }
    }
    if (step.transitions.length === 0) {
      errors.push(
        `step '${name}' is a dead-end: it declares no transitions (next/terminal/canFail/pause)`,
      );
    }
    forward.set(name, targets);
  }
  return forward;
}

/**
 * Warn about steps that cannot reach any `terminate`/`fail` sink (possible
 * unbounded loop or missing terminal) — computed by reverse BFS from the sinks.
 */
function terminalReachabilityWarnings(
  manifest: AgentManifest,
  names: Set<string>,
  forward: Map<string, Set<string>>,
): string[] {
  const sinks = Object.entries(manifest.steps)
    .filter(([, s]) =>
      s.transitions.some((t) => t.kind === "terminate" || t.kind === "fail"),
    )
    .map(([name]) => name);
  if (sinks.length === 0) {
    return [
      "no step can terminate or fail — the workflow has no terminal state",
    ];
  }

  const reverse = new Map<string, Set<string>>();
  for (const name of names) reverse.set(name, new Set());
  for (const [name, targets] of forward) {
    for (const t of targets) reverse.get(t)?.add(name);
  }

  const canReach = bfs(sinks, reverse);
  const warnings: string[] = [];
  for (const name of names) {
    if (!canReach.has(name)) {
      warnings.push(
        `step '${name}' cannot reach any terminate/fail (possible unbounded loop or missing terminal)`,
      );
    }
  }
  return warnings;
}

/** Multi-source BFS over an adjacency map; returns the set of reachable nodes. */
function bfs(
  starts: readonly string[],
  edges: Map<string, Set<string>>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) ?? [])
      if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

/**
 * Recursively remove `additionalProperties: false` from a generated JSON Schema.
 *
 * `z.toJSONSchema()` (Zod v4) marks every converted object as closed
 * (`additionalProperties: false`), top-level and nested. A plain `z.object()`
 * ignores keys it doesn't name when it parses, rather than rejecting them, so a
 * step input that carries extra fields should still be accepted. Removing the
 * closed-object marker keeps the generated schema forward-compatible with inputs
 * that gain fields over time.
 *
 * Only the closed form (`additionalProperties: false`) is removed; a typed
 * catchall (`additionalProperties: { ... }`) is preserved. A property literally
 * named `additionalProperties` is never the boolean `false`, so it is untouched.
 */
function relaxAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(relaxAdditionalProperties);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "additionalProperties" && v === false) {
        continue;
      }
      out[key] = relaxAdditionalProperties(v);
    }
    return out;
  }
  return value;
}

/**
 * Remove from the JSON Schema's top-level `required` array any key whose
 * `properties` entry declares a `default`. A caller may omit such a field — Zod
 * supplies the default on parse — so it should not be reported as missing.
 * Operates only on the top level; nested objects are out of scope.
 */
function dropDefaultedFromRequired(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const required = schema.required;
  const properties = schema.properties;
  if (
    !Array.isArray(required) ||
    !properties ||
    typeof properties !== "object"
  ) {
    return schema;
  }
  const props = properties as Record<string, unknown>;
  const filtered = required.filter((key) => {
    if (typeof key !== "string") return true;
    const prop = props[key];
    return !(prop && typeof prop === "object" && "default" in prop);
  });
  if (filtered.length === required.length) {
    return schema;
  }
  return { ...schema, required: filtered };
}
