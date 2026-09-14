import {
  AssistantContextError,
  assistantContentHash,
  assistantContextLimits,
  assistantRevision,
  assistantManifestFields,
  encodeAssistantContext,
  validateSourceVersion,
  validateInstructionSet,
  validateAssistantFacts,
  validateAcceptedAssistantContext,
  type SourceVersion,
  type InstructionSet,
  type AcceptedAssistantContext,
  type AssistantContextFacts,
} from "@sapiom/opencode";
import {
  contextPolicy,
  type AssistantGuidance,
  type StudioAssistantContext,
} from "./studio-assistant-context.js";

export type {
  SourceVersion,
  InstructionSet,
  AcceptedAssistantContext,
} from "@sapiom/opencode";
export interface SourceMaterial {
  readonly sourceId: string;
  readonly bytes: Uint8Array;
}
export interface SkillPackageMember {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}
export type ReadonlySourceContent =
  | { readonly format: "utf8"; readonly text: string }
  | { readonly format: "json"; readonly text: string; readonly value: unknown }
  | {
      readonly format: "skill-package";
      readonly entrypoint: "SKILL.md";
      readonly members: readonly SkillPackageMember[];
    };
export interface AssistantContextCandidate {
  readonly context: StudioAssistantContext;
  readonly instructionSet: InstructionSet;
  readonly materials: readonly SourceMaterial[];
}
export interface ResolvedAssistantGuidance {
  readonly metadata: Omit<AssistantGuidance, "text" | "location">;
  readonly version: SourceVersion;
  readonly material?: SourceMaterial;
}
type SourceIdentity = Pick<
  SourceVersion,
  | "id"
  | "kind"
  | "authorityScope"
  | "source"
  | "scope"
  | "required"
  | "fallback"
>;
const check: (valid: unknown) => asserts valid = (valid) => {
  if (!valid) throw new AssistantContextError();
};
const keys = (
  value: unknown,
  names: readonly string[],
): Record<string, unknown> => {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  check(Object.keys(value).sort().join(",") === [...names].sort().join(","));
  return value as Record<string, unknown>;
};
const utf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new AssistantContextError();
  }
};
const packagePath = (value: unknown): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value) <= assistantContextLimits.bytes &&
  !/[\\:<>"|?*]/.test(value) &&
  [...value].every(
    (character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  ) &&
  Buffer.from(value).toString("utf8") === value &&
  value
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    );

/** Encode complete supplied artifacts; never follow a live filesystem location. */
export function encodeAssistantSkillPackage(
  members: readonly SkillPackageMember[],
): Uint8Array {
  check(
    Array.isArray(members) && members.length <= assistantContextLimits.entries,
  );
  let materialBytes = 0;
  const artifact = {
    schemaVersion: 1,
    entrypoint: "SKILL.md",
    members: members
      .map((member) => {
        keys(member, ["path", "bytes", "executable"]);
        check(
          packagePath(member.path) &&
            member.bytes instanceof Uint8Array &&
            typeof member.executable === "boolean",
        );
        materialBytes +=
          Buffer.byteLength(member.path) +
          4 * Math.ceil(member.bytes.byteLength / 3);
        check(materialBytes <= assistantContextLimits.bytes);
        const bytes = new Uint8Array(member.bytes);
        return {
          path: member.path,
          contentBase64: Buffer.from(bytes).toString("base64"),
          contentHash: assistantContentHash(bytes),
          executable: member.executable,
        };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  const bytes = Buffer.from(encodeAssistantContext(artifact));
  decodeAssistantSource("skill-package", bytes);
  return bytes;
}

/** Verify canonical catalogs and every package member, returning detached content. */
export function decodeAssistantSource(
  format: "utf8" | "json" | "skill-package",
  bytes: Uint8Array,
): ReadonlySourceContent {
  check(
    bytes instanceof Uint8Array &&
      bytes.byteLength <= assistantContextLimits.bytes,
  );
  const text = utf8(bytes);
  if (format === "utf8") {
    check(text.trim().length > 0);
    return Object.freeze({ format, text });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AssistantContextError();
  }
  check(encodeAssistantContext(value) === text);
  if (format === "json") return Object.freeze({ format, text, value });
  check(format === "skill-package");
  const artifact = keys(value, ["schemaVersion", "entrypoint", "members"]);
  check(
    artifact.schemaVersion === 1 &&
      artifact.entrypoint === "SKILL.md" &&
      Array.isArray(artifact.members),
  );
  const members: SkillPackageMember[] = [];
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const value of artifact.members) {
    const member = keys(value, [
      "path",
      "contentBase64",
      "contentHash",
      "executable",
    ]);
    check(
      packagePath(member.path) &&
        typeof member.contentBase64 === "string" &&
        typeof member.executable === "boolean",
    );
    const content = Buffer.from(member.contentBase64, "base64");
    const memberPath = member.path;
    check(
      content.toString("base64") === member.contentBase64 &&
        assistantContentHash(content) === member.contentHash,
    );
    const portablePath = memberPath.toLowerCase();
    check(!files.has(portablePath) && !directories.has(portablePath));
    const parents = portablePath.split("/").slice(0, -1);
    for (let index = 1; index <= parents.length; index++) {
      const directory = parents.slice(0, index).join("/");
      check(!files.has(directory));
      directories.add(directory);
    }
    files.add(portablePath);
    check(!members.length || members[members.length - 1]!.path < member.path);
    members.push(
      Object.freeze({
        path: member.path,
        bytes: new Uint8Array(content),
        executable: member.executable,
      }),
    );
  }
  const entrypoint = members.find((member) => member.path === "SKILL.md");
  check(entrypoint && utf8(entrypoint.bytes).trim().length > 0);
  return Object.freeze({
    format,
    entrypoint: "SKILL.md",
    members: Object.freeze(members),
  });
}

/** Distinguish exact available content from an explicit optional absence. */
export function createAssistantSource(
  identity: SourceIdentity,
  content:
    | { format: "utf8" | "json" | "skill-package"; bytes: Uint8Array }
    | { status: "unavailable" | "not-configured"; reason: string },
): { version: SourceVersion; material?: SourceMaterial } {
  const available = "bytes" in content;
  if (available)
    check(
      content.bytes instanceof Uint8Array &&
        content.bytes.byteLength <= assistantContextLimits.bytes,
    );
  const bytes = available ? new Uint8Array(content.bytes) : undefined;
  if (available) decodeAssistantSource(content.format, bytes!);
  const hash = bytes ? assistantContentHash(bytes) : null;
  const source = {
    ...identity,
    revision: "",
    ...(available
      ? {
          status: "available" as const,
          format: content.format,
          contentHash: hash!,
          contentRef: hash!,
        }
      : { status: content.status, contentHash: null, reason: content.reason }),
  };
  const version = { ...source, revision: assistantRevision(source) };
  validateSourceVersion(version, identity.authorityScope);
  return {
    version: JSON.parse(encodeAssistantContext(version)),
    ...(available
      ? {
          material: {
            sourceId: identity.id,
            bytes: bytes!,
          },
        }
      : {}),
  };
}

/** Snapshot facts using the shared schema; guidance lives only in retained materials. */
export function assistantContextFacts(
  context: StudioAssistantContext,
): AssistantContextFacts {
  const facts = Object.fromEntries(
    Object.entries(context).filter(
      ([key]) => !["schemaVersion", "revision", "guidance"].includes(key),
    ),
  );
  validateAssistantFacts(facts);
  return JSON.parse(encodeAssistantContext(facts));
}

/** Adapt the existing inline provider seam; mutable locations are never retained. */
export function retainAssistantGuidance(
  guidance: AssistantGuidance,
  authorityScope: string,
): ResolvedAssistantGuidance {
  const { text, location, ...metadata } = guidance;
  check(!location);
  if (guidance.status === "available")
    check(
      typeof text === "string" &&
        Buffer.byteLength(text) <= assistantContextLimits.bytes &&
        Buffer.from(text).toString("utf8") === text,
    );
  if (guidance.status !== "available")
    check(typeof guidance.reason === "string");
  const identity: SourceIdentity = {
    id: guidance.id,
    kind: guidance.kind,
    required: guidance.required,
    source: guidance.source,
    authorityScope,
    ...(guidance.scope === undefined ? {} : { scope: guidance.scope }),
  };
  const resolved = createAssistantSource(
    identity,
    guidance.status === "available"
      ? { format: "utf8", bytes: Buffer.from(text ?? "") }
      : {
          status: guidance.status,
          reason: guidance.reason!,
        },
  );
  return { metadata, ...resolved };
}

/** Retain policy and explicit manifests alongside provider-supplied content. */
export function createAssistantContextCandidate(
  context: StudioAssistantContext,
  authorityScope: string,
  guidance?: ResolvedAssistantGuidance[],
): AssistantContextCandidate {
  encodeAssistantContext(context);
  guidance ??= context.guidance.map((source) =>
    retainAssistantGuidance(source, authorityScope),
  );
  check(guidance.length <= assistantContextLimits.entries);
  const facts = assistantContextFacts(context);
  const policy = createAssistantSource(
    {
      id: "studio-context-policy",
      kind: "policy",
      required: true,
      source: "host:studio-context-policy",
      authorityScope,
    },
    { format: "utf8", bytes: Buffer.from(contextPolicy) },
  );
  for (const item of guidance) {
    check(
      item.metadata.id === item.version.id &&
        item.metadata.kind === item.version.kind &&
        item.metadata.status === item.version.status &&
        item.metadata.required === item.version.required &&
        item.metadata.source === item.version.source &&
        item.metadata.scope === item.version.scope,
    );
  }
  const sources = [policy.version, ...guidance.map((item) => item.version)];
  const materials = [
    policy.material!,
    ...guidance.flatMap((item) => (item.material ? [item.material] : [])),
  ];
  const manifests = [
    {
      kind: "project" as const,
      value: {
        schemaVersion: 1,
        sources: sources.filter((source) => source.kind === "project"),
      },
    },
    {
      kind: "skill" as const,
      value: {
        schemaVersion: 1,
        sources: sources.filter((source) => source.kind === "skill"),
      },
    },
    {
      kind: "mcp" as const,
      value: {
        schemaVersion: 1,
        sources: sources.filter((source) => source.kind === "mcp"),
      },
    },
    {
      kind: "mcp" as const,
      value: { schemaVersion: 1, capabilities: facts.capabilities },
    },
  ].map((manifest, index) =>
    createAssistantSource(
      {
        id: assistantManifestFields[index]!,
        kind: manifest.kind,
        required: true,
        source: "host:accepted-manifest",
        authorityScope,
      },
      {
        format: "json",
        bytes: Buffer.from(encodeAssistantContext(manifest.value)),
      },
    ),
  );
  sources.push(...manifests.map((item) => item.version));
  materials.push(...manifests.map((item) => item.material!));
  const instructionSet = {
    revision: "",
    sources,
    scopeManifestRevision: manifests[0]!.version.revision,
    skillCatalogRevision: manifests[1]!.version.revision,
    mcpInstructionRevision: manifests[2]!.version.revision,
    mcpCatalogRevision: manifests[3]!.version.revision,
  };
  instructionSet.revision = assistantRevision(instructionSet);
  const retained = boundedMaterials(materials);
  const candidate = {
    context: structuredClone(context),
    instructionSet: JSON.parse(
      encodeAssistantContext(instructionSet),
    ) as InstructionSet,
    materials: retained.map((item) => ({
      sourceId: item.sourceId,
      bytes: new Uint8Array(item.bytes),
    })),
  };
  validateAssistantMaterials(
    instructionSet,
    candidate.materials,
    authorityScope,
  );
  return candidate;
}

function boundedMaterials(
  materials: readonly SourceMaterial[],
): SourceMaterial[] {
  check(
    Array.isArray(materials) &&
      materials.length <= assistantContextLimits.entries,
  );
  let materialBytes = 0;
  return materials.map(({ sourceId, bytes }) => {
    check(bytes instanceof Uint8Array);
    materialBytes += bytes.byteLength;
    check(materialBytes <= assistantContextLimits.bytes);
    return { sourceId, bytes };
  });
}

/** Check all accepted available references, including optional sources and packages. */
export function validateAssistantMaterials(
  instructionSet: InstructionSet,
  materials: readonly SourceMaterial[],
  authorityScope: string,
): ReadonlyMap<string, ReadonlySourceContent> {
  materials = boundedMaterials(materials);
  validateInstructionSet(instructionSet, authorityScope);
  check(
    new Set(materials.map((item) => item.sourceId)).size === materials.length,
  );
  const available = instructionSet.sources.filter(
    (source) => source.status === "available",
  );
  check(available.length === materials.length);
  const decoded = new Map<string, ReadonlySourceContent>();
  for (const source of available) {
    check(source.status === "available");
    const material = materials.find((item) => item.sourceId === source.id);
    check(
      material && assistantContentHash(material.bytes) === source.contentHash,
    );
    decoded.set(
      source.id,
      decodeAssistantSource(source.format, material.bytes),
    );
  }
  return decoded;
}

/** Construct an identity-bound record; only the store's commit establishes retention. */
export function acceptedAssistantRecord(
  candidate: AssistantContextCandidate,
  authorityScope: string,
  conversationId: string,
  acceptanceId: string,
): AcceptedAssistantContext {
  validateAssistantMaterials(
    candidate.instructionSet,
    candidate.materials,
    authorityScope,
  );
  const record = {
    schemaVersion: 1 as const,
    authorityScope,
    conversationId,
    acceptanceId,
    revision: "",
    context: assistantContextFacts(candidate.context),
    instructionSet: candidate.instructionSet,
  };
  record.revision = assistantRevision(record);
  validateAcceptedAssistantContext(record);
  return JSON.parse(encodeAssistantContext(record));
}
