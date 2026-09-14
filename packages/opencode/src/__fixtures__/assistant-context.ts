import {
  serializeAcceptedAssistantSystem,
  studioAssistantCompletionSystem,
} from "../assistant-context-wire.js";
import {
  assistantContentHash,
  assistantRevision,
  assistantManifestFields,
  type AcceptedAssistantContext,
  type SourceVersion,
} from "../assistant-context-contract.js";

export const fixtureScope = "a".repeat(64);
export const fixtureToken = "11111111-1111-4111-8111-111111111111";
export function fixtureSource(
  id: string,
  kind: SourceVersion["kind"],
  text: string,
  format: "utf8" | "json" = "utf8",
): SourceVersion {
  const source: SourceVersion = {
    id,
    kind,
    authorityScope: fixtureScope,
    source: "fixture",
    required: true,
    status: "available",
    format,
    contentHash: assistantContentHash(text),
    contentRef: assistantContentHash(text),
    revision: "",
  };
  return { ...source, revision: assistantRevision(source) };
}
export function fixtureAccepted(): AcceptedAssistantContext {
  const manifests = assistantManifestFields.map((field) =>
    fixtureSource(field, "mcp", "[]", "json"),
  );
  const instructionSet = {
    revision: "",
    sources: [
      fixtureSource("policy", "policy", "Studio policy"),
      fixtureSource("profile", "profile", "Profile\r\nexact bytes"),
      ...manifests,
    ],
    scopeManifestRevision: manifests[0]!.revision,
    skillCatalogRevision: manifests[1]!.revision,
    mcpInstructionRevision: manifests[2]!.revision,
    mcpCatalogRevision: manifests[3]!.revision,
  };
  instructionSet.revision = assistantRevision(instructionSet);
  const accepted: AcceptedAssistantContext = {
    schemaVersion: 1,
    acceptanceId: fixtureToken,
    authorityScope: fixtureScope,
    conversationId: "ses_fixture",
    revision: "",
    instructionSet,
    context: {
      session: { id: "studio-fixture", cwd: "/workspace", projectId: null },
      environment: "test",
      selectedAgent: { status: "none" },
      boundAgent: { status: "not-provided" },
      agents: [],
      capabilities: [],
    },
  };
  return { ...accepted, revision: assistantRevision(accepted) };
}

export function fixtureSystem(
  sessionID = "ses_fixture",
  token = fixtureToken,
  text = "Profile\r\nexact bytes",
) {
  const original = fixtureAccepted();
  const instructions = {
    ...original.instructionSet,
    sources: original.instructionSet.sources.map((source) =>
      source.id === "profile"
        ? fixtureSource("profile", "profile", text)
        : source,
    ),
  };
  instructions.revision = assistantRevision(instructions);
  const record = {
    ...original,
    conversationId: sessionID,
    instructionSet: instructions,
  };
  record.revision = assistantRevision(record);
  const { context, instructionSet, ...accepted } = record;
  return serializeAcceptedAssistantSystem(
    studioAssistantCompletionSystem(token),
    {
      schemaVersion: 2,
      accepted,
      context,
      attemptToken: token,
      stable: {
        policy: { sourceId: "policy", text: "Studio policy" },
        guidance: [{ sourceId: "profile", text }],
        manifests: instructionSet.sources
          .filter(
            (source) =>
              source.status === "available" && source.format === "json",
          )
          .map((source) => ({ sourceId: source.id, text: "[]" })),
        sourceManifest: instructionSet,
      },
    },
  );
}
