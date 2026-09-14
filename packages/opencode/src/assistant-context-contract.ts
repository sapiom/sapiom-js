import { createHash } from "node:crypto";

/** One format shared by the host's durable records and native saved prompts. */
export interface AssistantContextAgent {
  name: string;
  path: string;
  definitionId: number | null;
}
/** An explicit selection state; only not-provided permits a binding fallback. */
export type AssistantAgentContext =
  | { status: "available"; agent: AssistantContextAgent }
  | { status: "none" | "not-provided" }
  | { status: "unavailable"; path: string };
/** Host-observed connection and tool-catalog facts; configured is not usable. */
export interface AssistantCapability {
  name: string;
  status: "available" | "configured" | "unavailable";
  tools: string[];
}
/** Authorized per-submission facts, without duplicated guidance bodies. */
export interface AssistantContextFacts {
  session: { id: string; cwd: string; projectId: string | null };
  environment: string;
  selectedAgent: AssistantAgentContext;
  boundAgent: AssistantAgentContext;
  agents: AssistantContextAgent[];
  capabilities: AssistantCapability[];
}
/** Immutable provenance and byte identity, or an explicit optional absence. */
export type SourceVersion = Readonly<
  {
    id: string;
    kind: "policy" | "profile" | "project" | "skill" | "mcp" | "continuation";
    authorityScope: string;
    source: string;
    scope?: string;
    revision: string;
    required: boolean;
    fallback?: { fromSource: string; reason: string };
  } & (
    | {
        status: "available";
        contentHash: string;
        contentRef: string;
        format: "utf8" | "json" | "skill-package";
      }
    | {
        status: "unavailable" | "not-configured";
        contentHash: null;
        reason: string;
        contentRef?: never;
      }
  )
>;
/** Ordered source versions and retained discovery/catalog manifest revisions. */
export interface InstructionSet {
  readonly revision: string;
  readonly sources: readonly SourceVersion[];
  readonly scopeManifestRevision: string;
  readonly skillCatalogRevision: string;
  readonly mcpInstructionRevision: string;
  readonly mcpCatalogRevision: string;
}
/** Reference to one accepted record; never a substitute for current authorization. */
export interface AcceptedContextRef {
  readonly schemaVersion: 1;
  readonly acceptanceId: string;
  readonly authorityScope: string;
  readonly conversationId: string;
  readonly revision: string;
}
/** Retained facts and instruction references bound to one native conversation. */
export interface AcceptedAssistantContext extends AcceptedContextRef {
  readonly context: AssistantContextFacts;
  readonly instructionSet: InstructionSet;
}

/** Serialization safety bounds (bundled profile ~30 KiB), never truncation rules. */
export const assistantContextLimits = Object.freeze({
  bytes: 4 * 1024 * 1024,
  entries: 4096,
  depth: 24,
});
/** Safe context failure; deliberately contains no paths, credentials or source text. */
export class AssistantContextError extends Error {
  constructor() {
    super("Studio assistant context could not be verified");
    this.name = "StudioAssistantContextError";
  }
}
export function contextCheck(condition: unknown): asserts condition {
  if (!condition) throw new AssistantContextError();
}
export function contextObject(value: unknown): Record<string, unknown> {
  contextCheck(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  const prototype = Object.getPrototypeOf(value);
  contextCheck(prototype === Object.prototype || prototype === null);
  contextCheck(Object.keys(value).length <= assistantContextLimits.entries);
  return value as Record<string, unknown>;
}
export function contextKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const object = contextObject(value);
  contextCheck(
    required.every((key) => Object.prototype.hasOwnProperty.call(object, key)),
  );
  contextCheck(
    Object.keys(object).every(
      (key) => required.includes(key) || optional.includes(key),
    ),
  );
  return object;
}
export function contextText(value: unknown): asserts value is string {
  contextCheck(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= assistantContextLimits.bytes,
  );
}
export function contextHash(value: unknown): asserts value is string {
  contextCheck(typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}
export function contextUuid(value: unknown): asserts value is string {
  contextCheck(
    typeof value === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        value,
      ),
  );
}
export function contextList(value: unknown): unknown[] {
  contextCheck(
    Array.isArray(value) &&
      Object.getPrototypeOf(value) === Array.prototype &&
      value.length <= assistantContextLimits.entries &&
      Reflect.ownKeys(value).length === value.length + 1,
  );
  for (let index = 0; index < value.length; index++)
    contextCheck(Object.prototype.hasOwnProperty.call(value, index));
  return value;
}
export function contextUnique(values: readonly unknown[]) {
  contextCheck(new Set(values).size === values.length);
}
/** Deterministic JSON only; text/byte hashing never changes line endings. */
export function encodeAssistantContext(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const count = (text: string) => {
    bytes += Buffer.byteLength(text);
    contextCheck(bytes <= assistantContextLimits.bytes);
  };
  const countString = (text: string) => {
    contextCheck(Buffer.byteLength(text) <= assistantContextLimits.bytes);
    count(JSON.stringify(text));
  };
  const visit = (item: unknown, depth: number): unknown => {
    contextCheck(
      depth <= assistantContextLimits.depth &&
        ++nodes <= assistantContextLimits.entries * 32,
    );
    if (typeof item === "string") {
      countString(item);
      return item;
    }
    if (item === null || typeof item === "boolean") {
      count(JSON.stringify(item));
      return item;
    }
    if (typeof item === "number") {
      contextCheck(Number.isFinite(item));
      count(JSON.stringify(item));
      return item;
    }
    if (Array.isArray(item)) {
      const entries = contextList(item);
      count("[]" + ",".repeat(Math.max(0, entries.length - 1)));
      return Array.from(entries, (child) => visit(child, depth + 1));
    }
    const entries = Object.entries(contextObject(item));
    count("{}" + ",".repeat(Math.max(0, entries.length - 1)));
    return Object.fromEntries(
      entries
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => {
          countString(key);
          count(":");
          return [key, visit(child, depth + 1)];
        }),
    );
  };
  const encoded = JSON.stringify(visit(value, 0));
  contextCheck(Buffer.byteLength(encoded) <= assistantContextLimits.bytes);
  return encoded;
}
/** SHA-256 of exact bytes (strings use UTF-8), with no newline normalization. */
export const assistantContentHash = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
/** SHA-256 of bounded deterministic JSON, including provenance and applicability. */
export const assistantDescriptorHash = (value: unknown): string =>
  assistantContentHash(encodeAssistantContext(value));
/** Hash the complete descriptor excluding only its own revision field. */
export function assistantRevision<T extends { readonly revision: string }>(
  value: T,
) {
  return assistantDescriptorHash(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "revision"),
    ),
  );
}

/** Reject malformed, unavailable-required, foreign-scope or misidentified sources. */
export function validateSourceVersion(
  value: unknown,
  authorityScope: string,
): asserts value is SourceVersion {
  const source = contextObject(value);
  const available = source.status === "available";
  contextKeys(
    source,
    [
      "id",
      "kind",
      "authorityScope",
      "source",
      "revision",
      "required",
      "status",
      "contentHash",
      ...(available ? ["contentRef", "format"] : ["reason"]),
    ],
    ["scope", "fallback"],
  );
  for (const key of ["id", "source"]) contextText(source[key]);
  contextCheck(
    ["policy", "profile", "project", "skill", "mcp", "continuation"].includes(
      String(source.kind),
    ),
  );
  contextHash(source.authorityScope);
  contextCheck(
    source.authorityScope === authorityScope &&
      typeof source.required === "boolean",
  );
  contextHash(source.revision);
  if (source.scope !== undefined) contextText(source.scope);
  if (source.fallback !== undefined) {
    const fallback = contextKeys(source.fallback, ["fromSource", "reason"]);
    contextText(fallback.fromSource);
    contextText(fallback.reason);
  }
  if (available) {
    contextHash(source.contentHash);
    contextCheck(source.contentRef === source.contentHash);
    contextCheck(
      ["utf8", "json", "skill-package"].includes(source.format as string),
    );
  } else {
    contextCheck(
      ["unavailable", "not-configured"].includes(source.status as string),
    );
    contextCheck(source.contentHash === null && !source.required);
    contextText(source.reason);
  }
  contextCheck(source.revision === assistantRevision(value as SourceVersion));
}

/** Required references to retained scope, skill and MCP discovery/catalog records. */
export const assistantManifestFields = [
  "scopeManifestRevision",
  "skillCatalogRevision",
  "mcpInstructionRevision",
  "mcpCatalogRevision",
] as const;
/** Validate every source and retained manifest, then reconstruct the set revision. */
export function validateInstructionSet(
  value: unknown,
  authorityScope: string,
): asserts value is InstructionSet {
  encodeAssistantContext(value);
  const set = contextKeys(value, [
    "revision",
    "sources",
    ...assistantManifestFields,
  ]);
  const sources = contextList(set.sources);
  for (const source of sources) validateSourceVersion(source, authorityScope);
  const typed = sources as SourceVersion[];
  contextUnique(typed.map((source) => source.id));
  for (const field of assistantManifestFields) {
    contextHash(set[field]);
    contextCheck(
      typed.some(
        (source) =>
          source.id === field &&
          source.required &&
          source.revision === set[field] &&
          source.status === "available" &&
          source.format === "json",
      ),
    );
  }
  for (const kind of ["policy", "profile"])
    contextCheck(
      typed.some(
        (source) =>
          source.kind === kind &&
          source.required &&
          source.status === "available" &&
          source.format === "utf8",
      ),
    );
  contextHash(set.revision);
  contextCheck(set.revision === assistantRevision(value as InstructionSet));
}

function validateAgent(value: unknown): asserts value is AssistantContextAgent {
  const agent = contextKeys(value, ["name", "path", "definitionId"]);
  contextText(agent.name);
  contextText(agent.path);
  contextCheck(
    agent.definitionId === null ||
      (Number.isSafeInteger(agent.definitionId) &&
        Number(agent.definitionId) > 0),
  );
}
/** Validate fact shapes, unique inventory/tools and selected/bound membership. */
export function validateAssistantFacts(
  value: unknown,
): asserts value is AssistantContextFacts {
  encodeAssistantContext(value);
  const facts = contextKeys(value, [
    "session",
    "environment",
    "selectedAgent",
    "boundAgent",
    "agents",
    "capabilities",
  ]);
  const session = contextKeys(facts.session, ["id", "cwd", "projectId"]);
  contextText(session.id);
  contextText(session.cwd);
  contextText(facts.environment);
  if (session.projectId !== null) contextText(session.projectId);
  const agents = contextList(facts.agents);
  for (const agent of agents) validateAgent(agent);
  contextUnique((agents as AssistantContextAgent[]).map((agent) => agent.path));
  for (const key of ["selectedAgent", "boundAgent"]) {
    const target = contextObject(facts[key]);
    contextCheck(
      ["available", "none", "not-provided", "unavailable"].includes(
        String(target.status),
      ),
    );
    contextKeys(target, [
      "status",
      ...(target.status === "available"
        ? ["agent"]
        : target.status === "unavailable"
          ? ["path"]
          : []),
    ]);
    if (target.status === "available") {
      validateAgent(target.agent);
      contextCheck(
        agents.some(
          (agent) =>
            encodeAssistantContext(agent) ===
            encodeAssistantContext(target.agent),
        ),
      );
    }
    if (target.status === "unavailable") contextText(target.path);
  }
  const capabilities = contextList(facts.capabilities);
  for (const value of capabilities) {
    const capability = contextKeys(value, ["name", "status", "tools"]);
    contextText(capability.name);
    contextCheck(
      ["available", "configured", "unavailable"].includes(
        String(capability.status),
      ),
    );
    const tools = contextList(capability.tools);
    tools.forEach(contextText);
    contextUnique(tools);
  }
  contextUnique(
    (capabilities as AssistantCapability[]).map(
      (capability) => capability.name,
    ),
  );
}
/** Validate the opaque acceptance/conversation identifiers and SHA-256 fields. */
export function validateAcceptedContextRef(
  value: unknown,
): asserts value is AcceptedContextRef {
  const ref = contextKeys(value, [
    "schemaVersion",
    "acceptanceId",
    "authorityScope",
    "conversationId",
    "revision",
  ]);
  contextCheck(ref.schemaVersion === 1);
  contextUuid(ref.acceptanceId);
  contextHash(ref.authorityScope);
  contextHash(ref.revision);
  contextCheck(
    typeof ref.conversationId === "string" &&
      /^ses_[A-Za-z0-9_-]{1,128}$/.test(ref.conversationId),
  );
}
/** Validate the complete bounded record and recompute its accepted revision. */
export function validateAcceptedAssistantContext(
  value: unknown,
): asserts value is AcceptedAssistantContext {
  encodeAssistantContext(value);
  const object = contextKeys(value, [
    "schemaVersion",
    "acceptanceId",
    "authorityScope",
    "conversationId",
    "revision",
    "context",
    "instructionSet",
  ]);
  const { context, instructionSet, ...reference } = object;
  validateAcceptedContextRef(reference);
  validateAssistantFacts(context);
  validateInstructionSet(instructionSet, reference.authorityScope);
  contextCheck(
    reference.revision === assistantRevision(value as AcceptedAssistantContext),
  );
}
