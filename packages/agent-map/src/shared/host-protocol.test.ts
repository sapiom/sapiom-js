import { describe, expect, it } from "vitest";
import {
  McpCapabilitiesSchema,
  StudioHostBootstrapSchema,
  StudioHostContextSchema,
  supportsStudioContext,
} from "./host-protocol.js";

const descriptor = {
  descriptorVersion: 1,
  packageName: "@sapiom/mcp",
  packageVersion: "0.17.0",
  artifactHash: "a".repeat(64),
  hostProtocolVersions: [1],
  mapSchemaVersions: [1],
  features: ["studio-context"],
};
const context = {
  protocolVersion: 1,
  host: "sapiom-studio",
  projectId: "project_00000000-0000-4000-8000-000000000001",
  stateRoot: "/private/custom-state",
  userId: "local:machine",
  sessionId: "session",
  generation: 1,
  capabilities: ["session-context"],
};

describe("host protocol", () => {
  it("keeps support distinct from package versions and authorization", () => {
    expect(supportsStudioContext(McpCapabilitiesSchema.parse(descriptor))).toBe(
      true,
    );
    expect(
      supportsStudioContext({
        ...descriptor,
        descriptorVersion: 1,
        packageName: "@sapiom/mcp",
        hostProtocolVersions: [2],
      }),
    ).toBe(false);
    expect(
      supportsStudioContext(
        McpCapabilitiesSchema.parse({ ...descriptor, features: [] }),
      ),
    ).toBe(false);
    expect(StudioHostContextSchema.parse(context)).toEqual(context);
  });
  it.each([
    { descriptorVersion: 2 },
    { artifactHash: "invalid" },
    { packageName: "other" },
    { hostProtocolVersions: [-1] },
    { features: ["x".repeat(129)] },
    { authority: true },
  ])("rejects malformed descriptor %j", (patch) => {
    expect(
      McpCapabilitiesSchema.safeParse({ ...descriptor, ...patch }).success,
    ).toBe(false);
  });
  it.each([
    { protocolVersion: 2 },
    { projectId: "../project" },
    { generation: 0 },
    { userId: "" },
    { stateRoot: "a\nb" },
    { bearerToken: "must-not-echo" },
  ])("rejects invalid host context %j", (patch) => {
    expect(
      StudioHostContextSchema.safeParse({ ...context, ...patch }).success,
    ).toBe(false);
  });
  it("requires a complete private bootstrap, with no model scope claims", () => {
    const bootstrap = {
      contextUrl: "http://127.0.0.1:1234/mcp/agent-map/host-context",
      bearerToken: "opaque",
      expectedMcp: descriptor,
    };
    expect(StudioHostBootstrapSchema.parse(bootstrap)).toEqual(bootstrap);
    expect(
      StudioHostBootstrapSchema.safeParse({
        ...bootstrap,
        projectId: context.projectId,
      }).success,
    ).toBe(false);
  });
});
