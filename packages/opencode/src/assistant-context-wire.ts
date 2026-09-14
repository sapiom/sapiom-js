import {
  contextCheck,
  contextKeys,
  contextList,
  contextObject,
  contextText,
  contextUnique,
  contextUuid,
  encodeAssistantContext,
  assistantContentHash,
  assistantContextLimits,
  validateAcceptedAssistantContext,
  validateAcceptedContextRef,
  validateAssistantFacts,
  type AcceptedContextRef,
  type AcceptedAssistantContext,
  type AssistantContextFacts,
  type InstructionSet,
} from "./assistant-context-contract.js";

export interface RetainedWireGuidance {
  readonly sourceId: string;
  readonly text: string;
}
export interface AcceptedAssistantWireV2 {
  readonly schemaVersion: 2;
  readonly accepted: AcceptedContextRef;
  readonly attemptToken: string;
  readonly stable: {
    readonly policy: RetainedWireGuidance;
    readonly guidance: readonly RetainedWireGuidance[];
    readonly manifests: readonly RetainedWireGuidance[];
    readonly sourceManifest: InstructionSet;
  };
  readonly context: AssistantContextFacts;
}
export interface LegacyAssistantGuidance {
  id: string;
  kind: "profile" | "project" | "skill" | "continuation";
  required: boolean;
  source: string;
  scope?: string;
  revision: string | null;
  status: "available" | "unavailable" | "not-configured";
  text?: string;
  location?: string;
  reason?: string;
}
export interface LegacyAssistantContext extends AssistantContextFacts {
  schemaVersion: 1;
  revision: string;
  guidance: LegacyAssistantGuidance[];
}
export type ParsedStudioAssistantSystem =
  | { kind: "generic" }
  | { kind: "legacy-v2"; completionToken: string; savedSystem: string }
  | {
      kind: "legacy-inline-v1";
      completionToken: string;
      savedSystem: string;
      completionSystem: string;
      context: LegacyAssistantContext;
      policy: string;
      suffix: string;
    }
  | {
      kind: "accepted-v2";
      completionSystem: string;
      savedSystem: string;
      wire: AcceptedAssistantWireV2;
    };

export const acceptedContextHeader = "\n\nStudioAssistantContext/v2\n";
const legacyContextHeader = "\n\nStudioAssistantContext/v1\n";
const resultHeader = /^StudioAssistantResult\/v2:([^\n]+)\n/;

export function studioAssistantCompletionSystem(token: string): string {
  contextUuid(token);
  return `StudioAssistantResult/v2:${token}\nComplete the user's requested work before ending the turn, including any requested explanation. Finish necessary tool calls and examine their results before writing the final answer. A promise or plan to do the work is not completion. For conversational requests, provide the requested reply without unnecessary tool calls.\nBegin your final answer with exactly one of these bookkeeping lines, then write the answer on the following line, outside code blocks:\n<!-- studio-result:${token}:finished -->\n<!-- studio-result:${token}:failed -->\nUse finished only when the request is fulfilled. If you cannot finish, use failed and explain what remains and why. Do not include a result line in progress messages or alongside tool calls. Studio removes this line from the displayed answer; keep the rest of your answer in the format the user requested.`;
}

export function validateAcceptedAssistantWire(
  value: unknown,
): asserts value is AcceptedAssistantWireV2 {
  const wire = contextKeys(value, [
    "schemaVersion",
    "accepted",
    "attemptToken",
    "stable",
    "context",
  ]);
  contextCheck(wire.schemaVersion === 2);
  contextUuid(wire.attemptToken);
  validateAcceptedContextRef(wire.accepted);
  const stable = contextKeys(wire.stable, [
    "policy",
    "guidance",
    "manifests",
    "sourceManifest",
  ]);
  const accepted = {
    ...contextObject(wire.accepted),
    context: wire.context,
    instructionSet: stable.sourceManifest,
  };
  validateAcceptedAssistantContext(accepted);
  const policy = contextKeys(stable.policy, ["sourceId", "text"]);
  const guidance = contextList(stable.guidance);
  const manifests = contextList(stable.manifests);
  const seen: string[] = [];
  for (const [entries, format] of [
    [[policy, ...guidance], "utf8"],
    [manifests, "json"],
  ] as const) {
    for (const entry of entries) {
      const body = contextKeys(entry, ["sourceId", "text"]);
      contextText(body.sourceId);
      contextText(body.text);
      contextCheck(Buffer.from(body.text).toString("utf8") === body.text);
      const source = accepted.instructionSet.sources.find(
        (source) => source.id === body.sourceId,
      );
      contextCheck(source?.status === "available" && source.format === format);
      contextCheck(assistantContentHash(body.text) === source.contentHash);
      if (format === "json") {
        let manifest: unknown;
        try {
          manifest = JSON.parse(body.text);
        } catch {
          contextCheck(false);
        }
        contextCheck(encodeAssistantContext(manifest) === body.text);
      }
      seen.push(body.sourceId);
    }
  }
  contextUnique(seen);
  const sources = accepted.instructionSet.sources;
  contextCheck(
    sources.find((source) => source.id === policy.sourceId)?.kind === "policy",
  );
  const inline = sources.filter(
    (source) =>
      source.status === "available" && source.format !== "skill-package",
  );
  contextCheck(
    seen.length === inline.length &&
      inline.every((source) => seen.includes(source.id)),
  );
  const expectedGuidance = sources.filter(
    (source) =>
      source.status === "available" &&
      source.format === "utf8" &&
      source.id !== policy.sourceId,
  );
  contextCheck(
    guidance.every(
      (entry, index) =>
        contextObject(entry).sourceId === expectedGuidance[index]?.id,
    ),
  );
  const expectedManifests = sources.filter(
    (source) => source.status === "available" && source.format === "json",
  );
  contextCheck(
    manifests.every(
      (entry, index) =>
        contextObject(entry).sourceId === expectedManifests[index]?.id,
    ),
  );
  encodeAssistantContext(wire);
}

function legacyContext(
  value: unknown,
): asserts value is LegacyAssistantContext {
  const legacy = contextKeys(value, [
    "schemaVersion",
    "revision",
    "session",
    "environment",
    "selectedAgent",
    "boundAgent",
    "agents",
    "capabilities",
    "guidance",
  ]);
  contextCheck(legacy.schemaVersion === 1);
  const { revision, guidance } = legacy;
  const facts = Object.fromEntries(
    Object.entries(legacy).filter(
      ([key]) => !["schemaVersion", "revision", "guidance"].includes(key),
    ),
  );
  validateAssistantFacts(facts);
  // v1 used insertion-order JSON; changing it would invalidate saved history.
  contextCheck(
    revision ===
      assistantContentHash(JSON.stringify({ ...legacy, revision: undefined })),
  );
  const sources = contextList(guidance);
  for (const value of sources) {
    const source = contextKeys(
      value,
      ["id", "kind", "required", "source", "revision", "status"],
      ["scope", "text", "location", "reason"],
    );
    contextText(source.id);
    contextText(source.source);
    contextCheck(
      ["profile", "project", "skill", "continuation"].includes(
        source.kind as string,
      ),
    );
    contextCheck(
      ["available", "unavailable", "not-configured"].includes(
        source.status as string,
      ),
    );
    contextCheck(
      typeof source.required === "boolean" &&
        (source.revision === null || typeof source.revision === "string"),
    );
    for (const key of ["scope", "text", "location", "reason"])
      if (source[key] !== undefined) contextText(source[key]);
    contextCheck(
      !source.required ||
        (source.status === "available" && (source.text || source.location)),
    );
    if (source.status !== "available") contextText(source.reason);
  }
  contextUnique(sources.map((source) => contextObject(source).id));
  contextCheck(
    sources.some((value) => {
      const source = contextObject(value);
      return (
        source.kind === "profile" &&
        source.status === "available" &&
        typeof source.text === "string" &&
        source.text.trim()
      );
    }),
  );
  encodeAssistantContext(legacy);
}

/** Claimed Studio records fail closed; arbitrary non-Studio system prompts pass. */
export function parseStudioAssistantSystem(
  system: unknown,
  expected?: {
    conversationId: string;
    authorityScope: string;
    attemptToken?: string;
  },
): ParsedStudioAssistantSystem {
  if (system === undefined) return { kind: "generic" };
  contextCheck(
    typeof system === "string" &&
      Buffer.byteLength(system) <= assistantContextLimits.bytes,
  );
  const leading = resultHeader.exec(system);
  const claimed = /(?:^|\n)StudioAssistant(?:Result|Context)\//.test(system);
  if (!leading) {
    contextCheck(!claimed);
    return { kind: "generic" };
  }
  const token = leading[1]!;
  contextUuid(token);
  if (expected?.attemptToken !== undefined)
    contextCheck(token === expected.attemptToken);
  const boundary = system.indexOf("\n\nStudioAssistantContext/");
  if (boundary === -1) {
    contextCheck(
      !system.includes("\nStudioAssistantContext/") &&
        !system.slice(leading[0].length).includes("\nStudioAssistantResult/"),
    );
    return { kind: "legacy-v2", completionToken: token, savedSystem: system };
  }
  const completionSystem = system.slice(0, boundary);
  if (system.startsWith(acceptedContextHeader, boundary)) {
    contextCheck(completionSystem === studioAssistantCompletionSystem(token));
    const json = system.slice(boundary + acceptedContextHeader.length);
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      contextCheck(false);
    }
    contextCheck(encodeAssistantContext(value) === json);
    validateAcceptedAssistantWire(value);
    contextCheck(value.attemptToken === token);
    if (expected)
      contextCheck(
        value.accepted.conversationId === expected.conversationId &&
          value.accepted.authorityScope === expected.authorityScope &&
          (expected.attemptToken === undefined ||
            value.attemptToken === expected.attemptToken),
      );
    return {
      kind: "accepted-v2",
      completionSystem,
      savedSystem: system,
      wire: value,
    };
  }
  contextCheck(system.startsWith(legacyContextHeader, boundary));
  const payload = system.slice(boundary + legacyContextHeader.length);
  const newline = payload.lastIndexOf("\n");
  contextCheck(newline > 0);
  const policy = payload.slice(0, newline);
  contextCheck(!/(?:^|\n)StudioAssistant(?:Context|Result)\//.test(policy));
  let value: unknown;
  try {
    value = JSON.parse(payload.slice(newline + 1));
  } catch {
    contextCheck(false);
  }
  legacyContext(value);
  contextCheck(JSON.stringify(value) === payload.slice(newline + 1));
  return {
    kind: "legacy-inline-v1",
    completionToken: token,
    savedSystem: system,
    completionSystem,
    context: value,
    policy,
    suffix: system.slice(boundary),
  };
}

export function serializeAcceptedAssistantSystem(
  completionSystem: string,
  wire: AcceptedAssistantWireV2,
): string {
  const saved =
    completionSystem + acceptedContextHeader + encodeAssistantContext(wire);
  parseStudioAssistantSystem(saved);
  return saved;
}

/** Only called after trusted saved-system matching in the native hook. */
export function projectStudioAssistantSystem(
  parsed: Extract<
    ParsedStudioAssistantSystem,
    { kind: "accepted-v2" | "legacy-inline-v1" }
  >,
): string[] {
  if (parsed.kind === "legacy-inline-v1") {
    const { guidance, ...facts } = parsed.context;
    return [
      parsed.policy,
      ...guidance
        .filter((source) => source.status === "available" && source.text)
        .map((source) => source.text!),
      JSON.stringify(
        guidance.map((source) =>
          Object.fromEntries(
            Object.entries(source).filter(([key]) => key !== "text"),
          ),
        ),
      ),
      parsed.completionSystem,
      JSON.stringify(facts),
    ];
  }
  const { stable, context, accepted } = parsed.wire;
  return [
    stable.policy.text,
    ...stable.guidance.map((source) => source.text),
    encodeAssistantContext({
      sourceManifest: stable.sourceManifest,
      manifests: stable.manifests,
    }),
    parsed.completionSystem,
    encodeAssistantContext({ accepted, context }),
  ];
}

export function acceptedContextFromWire(
  wire: AcceptedAssistantWireV2,
): AcceptedAssistantContext {
  validateAcceptedAssistantWire(wire);
  return {
    ...wire.accepted,
    context: wire.context,
    instructionSet: wire.stable.sourceManifest,
  };
}
