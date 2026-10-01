import { z } from "zod";
import { isStudioProjectId } from "./project-id.js";
import { isAgentMapBoundedText } from "./agent-map-codec.js";

// Protocol, persisted schema, package release and map revision are independent.
export const AGENT_MAP_HOST_PROTOCOL_VERSION = 1;
export const MCP_CAPABILITIES_FLAG = "--describe-capabilities";
export const STUDIO_HOST_CONTEXT_ENV = "SAPIOM_STUDIO_HOST_CONTEXT";
export const STUDIO_HOST_CONTEXT_PATH = "/mcp/agent-map/host-context";
export const HOST_MESSAGE_MAX_BYTES = 16_384;

const text = (max: number) =>
  z.string().refine((value) => isAgentMapBoundedText(value, max));
const versions = z.array(z.number().int().positive().safe()).max(16);
const features = z.array(text(128)).max(32);

/** Feature support is not authorization, nor a choice to activate shared maps. */
export const McpCapabilitiesSchema = z
  .object({
    descriptorVersion: z.literal(1),
    packageName: z.literal("@sapiom/mcp"),
    packageVersion: text(128),
    artifactHash: z.string().regex(/^[0-9a-f]{64}$/u),
    hostProtocolVersions: versions,
    mapSchemaVersions: versions,
    features,
  })
  .strict();
export type McpCapabilities = z.infer<typeof McpCapabilitiesSchema>;

/** Private launcher data, never model-supplied tool arguments. */
export const StudioHostBootstrapSchema = z
  .object({
    contextUrl: text(2_048).pipe(z.string().url()),
    bearerToken: text(1_024),
    expectedMcp: McpCapabilitiesSchema,
  })
  .strict();
export type StudioHostBootstrap = z.infer<typeof StudioHostBootstrapSchema>;

/** A current admission check, not a durable grant to write the filesystem. */
export const StudioHostContextSchema = z
  .object({
    protocolVersion: z.literal(AGENT_MAP_HOST_PROTOCOL_VERSION),
    host: z.literal("sapiom-studio"),
    projectId: z.string().refine(isStudioProjectId),
    stateRoot: text(4_096),
    userId: text(256),
    sessionId: text(256),
    generation: z.number().int().positive().safe(),
    capabilities: features,
  })
  .strict();
export type StudioHostContext = z.infer<typeof StudioHostContextSchema>;

export function supportsStudioContext(value: McpCapabilities): boolean {
  return (
    value.hostProtocolVersions.includes(AGENT_MAP_HOST_PROTOCOL_VERSION) &&
    value.features.includes("studio-context")
  );
}
