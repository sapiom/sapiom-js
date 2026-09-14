import { createHash } from "node:crypto";

/** One format shared by the host's durable records and native saved prompts. */
export interface AssistantContextAgent {
  name: string;
  path: string;
  definitionId: number | null;
}
export type AssistantAgentContext =
  | { status: "available"; agent: AssistantContextAgent }
  | { status: "none" | "not-provided" }
  | { status: "unavailable"; path: string };
export interface AssistantCapability {
  name: string;
  status: "available" | "configured" | "unavailable";
  tools: string[];
}
export interface AssistantContextFacts {
  session: { id: string; cwd: string; projectId: string | null };
  environment: string;
  selectedAgent: AssistantAgentContext;
  boundAgent: AssistantAgentContext;
  agents: AssistantContextAgent[];
  capabilities: AssistantCapability[];
}
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
export interface InstructionSet {
  readonly revision: string;
  readonly sources: readonly SourceVersion[];
  readonly scopeManifestRevision: string;
  readonly skillCatalogRevision: string;
  readonly mcpInstructionRevision: string;
  readonly mcpCatalogRevision: string;
}
export interface AcceptedContextRef {
  readonly schemaVersion: 1;
  readonly acceptanceId: string;
  readonly authorityScope: string;
  readonly conversationId: string;
  readonly revision: string;
}
export interface AcceptedAssistantContext extends AcceptedContextRef {
  readonly context: AssistantContextFacts;
  readonly instructionSet: InstructionSet;
}

// A complete bundled profile is ~30 KiB. These are serialization safety limits,
// not truncation rules or a model context budget; oversized required data fails.
export const assistantContextLimits = {
  bytes: 4 * 1024 * 1024,
  entries: 4096,
  depth: 24,
};
export class AssistantContextError extends Error {
  constructor() {
    super("Studio assistant context unavailable");
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
    Array.isArray(value) && value.length <= assistantContextLimits.entries,
  );
  return value;
}
export function contextUnique(values: readonly unknown[]) {
  contextCheck(new Set(values).size === values.length);
}
/** Deterministic JSON only; text/byte hashing never changes line endings. */
export function encodeAssistantContext(value: unknown): string {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    contextCheck(
      depth <= assistantContextLimits.depth &&
        ++nodes <= assistantContextLimits.entries * 32,
    );
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number") {
      contextCheck(Number.isFinite(item));
      return item;
    }
    if (Array.isArray(item))
      return contextList(item).map((child) => visit(child, depth + 1));
    return Object.fromEntries(
      Object.entries(contextObject(item))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, visit(child, depth + 1)]),
    );
  };
  const encoded = JSON.stringify(visit(value, 0));
  contextCheck(Buffer.byteLength(encoded) <= assistantContextLimits.bytes);
  return encoded;
}
export const assistantContentHash = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const assistantDescriptorHash = (value: unknown): string =>
  assistantContentHash(encodeAssistantContext(value));
export function assistantRevision<T extends { readonly revision: string }>(
  value: T,
) {
  return assistantDescriptorHash(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "revision"),
    ),
  );
}

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

export const assistantManifestFields = [
  "scopeManifestRevision",
  "skillCatalogRevision",
  "mcpInstructionRevision",
  "mcpCatalogRevision",
] as const;
export function validateInstructionSet(
  value: unknown,
  authorityScope: string,
): asserts value is InstructionSet {
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
export function validateAssistantFacts(
  value: unknown,
): asserts value is AssistantContextFacts {
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
export function validateAcceptedAssistantContext(
  value: unknown,
): asserts value is AcceptedAssistantContext {
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
  encodeAssistantContext(value);
}
