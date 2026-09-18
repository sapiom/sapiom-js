import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  STUDIO_HOST_CONTEXT_ENV,
  type McpCapabilities,
} from "@sapiom/agent-map/host-protocol";
import { StudioHostContextClient } from "./studio-host-context.js";

const descriptor: McpCapabilities = {
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
  stateRoot: process.cwd(),
  projectId: "project_00000000-0000-4000-8000-000000000001",
  userId: "local:machine",
  sessionId: "session",
  generation: 1,
  capabilities: ["session-context"],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  let answer = (response: ServerResponse) => {
    response.end(JSON.stringify(context));
  };
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization ?? "");
    answer(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const bootstrap = {
    contextUrl: `http://127.0.0.1:${address.port}/mcp/agent-map/host-context`,
    bearerToken: "private-token",
    expectedMcp: descriptor,
  };
  const makeClient = (patch = {}) =>
    new StudioHostContextClient(
      {
        [STUDIO_HOST_CONTEXT_ENV]: JSON.stringify({ ...bootstrap, ...patch }),
      },
      async () => descriptor,
      80,
    );
  return {
    bootstrap,
    makeClient,
    seen,
    answer: (next: typeof answer) => {
      answer = next;
    },
  };
}

it("recognizes standalone and legacy Studio without looking up credentials or support", async () => {
  const describe = vi.fn();
  expect(await new StudioHostContextClient({}, describe).resolve()).toEqual({
    kind: "standalone",
  });
  expect(
    await new StudioHostContextClient(
      { SAPIOM_HARNESS_VERSION: "ancient" },
      describe,
    ).resolve(),
  ).toEqual({ kind: "legacy-studio" });
  expect(describe).not.toHaveBeenCalled();
});

it("verifies context with a bearer and revalidates on every operation", async () => {
  const f = await fixture();
  const client = f.makeClient();
  expect(await client.resolve()).toEqual({ kind: "studio", context });
  f.answer((response) => {
    response.writeHead(401).end("secret rejection detail");
  });
  expect(await client.resolve()).toEqual({
    kind: "unavailable-studio",
    reason: "host-unavailable",
  });
  expect(f.seen).toEqual(["Bearer private-token", "Bearer private-token"]);
});

it.each(["projectId", "userId", "sessionId", "stateRoot", "generation"])(
  "pins %s across host requests",
  async (key) => {
    const f = await fixture();
    const client = f.makeClient();
    await client.resolve();
    const changed = {
      projectId: "project_00000000-0000-4000-8000-000000000002",
      userId: "foreign",
      sessionId: "other",
      stateRoot: `${process.cwd()}/other`,
      generation: 2,
    };
    f.answer((response) =>
      response.end(
        JSON.stringify({
          ...context,
          [key]: changed[key as keyof typeof changed],
        }),
      ),
    );
    expect(await client.resolve()).toEqual({
      kind: "unavailable-studio",
      reason: "scope-changed",
    });
  },
);

it.each(["", "{", "null", "x".repeat(16_385)])(
  "never upgrades malformed explicit Studio bootstrap to standalone (%#)",
  async (raw) => {
    const result = await new StudioHostContextClient({
      [STUDIO_HOST_CONTEXT_ENV]: raw,
    }).resolve();
    expect(result).toEqual({
      kind: "unavailable-studio",
      reason: "invalid-bootstrap",
    });
  },
);

it.each([
  "https://127.0.0.1:1234/mcp/agent-map/host-context",
  "http://localhost:1234/mcp/agent-map/host-context",
  "http://example.com:1234/mcp/agent-map/host-context",
  "http://user:password@127.0.0.1:1234/mcp/agent-map/host-context",
  "http://127.0.0.1:1234/wrong",
  "http://127.0.0.1:1234/mcp/agent-map/host-context?projectId=foreign",
])(
  "rejects non-private endpoints before sending a credential: %s",
  async (contextUrl) => {
    const f = await fixture();
    expect(await f.makeClient({ contextUrl }).resolve()).toEqual({
      kind: "unavailable-studio",
      reason: "invalid-bootstrap",
    });
    expect(f.seen).toEqual([]);
  },
);

it("rejects a replaced artifact before sending credentials", async () => {
  const f = await fixture();
  expect(
    await f
      .makeClient({
        expectedMcp: { ...descriptor, artifactHash: "b".repeat(64) },
      })
      .resolve(),
  ).toEqual({ kind: "unavailable-studio", reason: "artifact-changed" });
  expect(f.seen).toEqual([]);
});

it.each([
  "redirect",
  "large",
  "timeout",
  "malformed",
  "protocol",
  "relative-root",
])("bounds %s responses", async (mode) => {
  const f = await fixture();
  f.answer((response) => {
    if (mode === "redirect")
      response.writeHead(302, { Location: f.bootstrap.contextUrl }).end();
    else if (mode === "large") response.end("x".repeat(16_385));
    else if (mode === "malformed") response.end("not-json-secret");
    else if (mode === "protocol")
      response.end(JSON.stringify({ ...context, protocolVersion: 2 }));
    else if (mode === "relative-root")
      response.end(JSON.stringify({ ...context, stateRoot: "relative" }));
  });
  expect(await f.makeClient().resolve()).toEqual({
    kind: "unavailable-studio",
    reason: "host-unavailable",
  });
  expect(f.seen).toHaveLength(1);
});
