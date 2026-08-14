import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { WorkflowInputContractResponse } from "@shared/types";

import type { CanvasGraph } from "./canvas-graph";
import type { RunTarget } from "./use-harness-state";

export interface StoredRunInput {
  value: unknown;
  schemaSignature: string | null;
}

const INPUT_PREFIX = "sapiom.studio.run-input.v1:";
const TARGET_PREFIX = "sapiom.studio.run-target.v1:";

function storageKey(prefix: string, workflowPath: string): string {
  return `${prefix}${encodeURIComponent(workflowPath)}`;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadStoredRunInput(
  workflowPath: string,
): StoredRunInput | null {
  try {
    const raw = browserStorage()?.getItem(
      storageKey(INPUT_PREFIX, workflowPath),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredRunInput>;
    if (!("value" in parsed)) return null;
    return {
      value: parsed.value,
      schemaSignature:
        typeof parsed.schemaSignature === "string"
          ? parsed.schemaSignature
          : null,
    };
  } catch {
    return null;
  }
}

export function saveStoredRunInput(
  workflowPath: string,
  value: unknown,
  schemaSignature: string | null,
): void {
  try {
    browserStorage()?.setItem(
      storageKey(INPUT_PREFIX, workflowPath),
      JSON.stringify({ value, schemaSignature } satisfies StoredRunInput),
    );
  } catch {
    // Device-only convenience must never prevent a run.
  }
}

export function loadStoredRunTarget(workflowPath: string): RunTarget {
  try {
    return browserStorage()?.getItem(
      storageKey(TARGET_PREFIX, workflowPath),
    ) === "prod"
      ? "prod"
      : "local";
  } catch {
    return "local";
  }
}

export function saveStoredRunTarget(
  workflowPath: string,
  target: RunTarget,
): void {
  try {
    browserStorage()?.setItem(storageKey(TARGET_PREFIX, workflowPath), target);
  } catch {
    // Preference persistence is best effort.
  }
}

/** Stable enough for a device-local stale-contract comparison. */
export function schemaSignature(schema: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, stable(child)]),
      );
    }
    return value;
  };
  return JSON.stringify(stable(schema));
}

function firstDeclaredExample(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }
  return Object.prototype.hasOwnProperty.call(schema, "example")
    ? schema.example
    : undefined;
}

/** Recursively materialize declared defaults without inventing optional data. */
export function defaultsFromSchema(schema: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(schema, "default")) {
    return schema.default;
  }
  if (schema.type === "object") {
    const properties = (schema.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(properties)) {
      const value = defaultsFromSchema(child);
      if (value !== undefined) result[key] = value;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  return undefined;
}

function skeletonScalar(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum[0];
  switch (schema.type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return requiredSkeletonFromSchema(schema);
    default:
      return null;
  }
}

/** Only required properties are synthesized; optional fields remain absent. */
export function requiredSkeletonFromSchema(
  schema: Record<string, unknown>,
): unknown {
  if (schema.type !== "object") return skeletonScalar(schema);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return Object.fromEntries(
    required.map((key) => [key, skeletonScalar(properties[key] ?? {})]),
  );
}

/** Merge optional declared defaults with placeholders for every required
 * branch. A partial set of defaults must not make the initial form invalid by
 * suppressing required siblings that happen not to declare one. */
function defaultsAndRequiredFromSchema(
  schema: Record<string, unknown>,
): unknown {
  const hasDefault = Object.prototype.hasOwnProperty.call(schema, "default");
  if (schema.type !== "object") return hasDefault ? schema.default : undefined;
  if (
    hasDefault &&
    (!schema.default ||
      typeof schema.default !== "object" ||
      Array.isArray(schema.default))
  ) {
    return schema.default;
  }
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const result: Record<string, unknown> = hasDefault
    ? { ...(schema.default as Record<string, unknown>) }
    : {};
  for (const [key, child] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const existing = result[key];
      if (
        child.type === "object" &&
        existing !== null &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        result[key] = defaultsAndRequiredFromSchema({
          ...child,
          default: existing,
        });
      }
      continue;
    }
    const childDefaults = defaultsFromSchema(child);
    if (childDefaults !== undefined) {
      result[key] = defaultsAndRequiredFromSchema(child);
    } else if (required.has(key)) {
      result[key] =
        defaultsAndRequiredFromSchema(child) ?? skeletonScalar(child);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Author example → declared defaults → required-field skeleton. */
export function resetValueForSchema(schema: Record<string, unknown>): unknown {
  const example = firstDeclaredExample(schema);
  if (example !== undefined) return example;
  const defaultsAndRequired = defaultsAndRequiredFromSchema(schema);
  if (defaultsAndRequired !== undefined) return defaultsAndRequired;
  return requiredSkeletonFromSchema(schema);
}

/** Turn the manifest-backed graph already visible in Studio into the same
 * contract shape as the server route. This is a last-known-good fallback only:
 * a successful fresh extraction always wins, while an extraction/load failure
 * must not force raw JSON when the exact entry schema is already on screen. */
export function inputContractFromCanvasGraph(
  graph: CanvasGraph,
): WorkflowInputContractResponse | null {
  const entry = graph.nodes.find((node) => node.id === graph.entry);
  if (!entry) return null;
  if (!entry.inputSchema) {
    return { status: "none", jsonSchema: null, example: {} };
  }
  return {
    status: "available",
    jsonSchema: entry.inputSchema,
    example: resetValueForSchema(entry.inputSchema),
  };
}

export interface InputValidator {
  validate: ValidateFunction;
  validateValue: (value: unknown) => ErrorObject[];
}

export function createInputValidator(
  schema: Record<string, unknown>,
): InputValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  return {
    validate,
    validateValue(value: unknown): ErrorObject[] {
      return validate(value) ? [] : [...(validate.errors ?? [])];
    },
  };
}

export function fieldPathForError(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missing = (error.params as { missingProperty?: unknown })
      .missingProperty;
    if (typeof missing === "string") return `${error.instancePath}/${missing}`;
  }
  return error.instancePath || "/";
}

export function humanizeValidationError(error: ErrorObject): string {
  const path = fieldPathForError(error)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(" → ");
  return `${path || "Input"} ${error.message ?? "is invalid"}`;
}
