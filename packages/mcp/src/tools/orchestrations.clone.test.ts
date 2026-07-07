import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(),
}));

// Keep the real module but stub the networked `clone` so the tool is tested
// without touching the backend or the filesystem.
vi.mock("@sapiom/orchestration-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@sapiom/orchestration-core")>();
  return { ...actual, clone: vi.fn() };
});

import { register } from "./orchestrations.js";
import { readCredentials } from "../credentials.js";
import { clone } from "@sapiom/orchestration-core";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer(): {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn(
      (_name: string, _desc: string, _schema: any, handler: ToolHandler) => {
        handlers.set(_name, handler);
      },
    ),
  } as unknown as McpServer;
  return { server, handlers };
}

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

const parse = (res: { content: Array<{ text: string }> }) =>
  JSON.parse(res.content[0].text);

describe("sapiom_dev_orchestrations_clone tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readCredentials).mockResolvedValue({
      apiKey: "sk_test",
      tenantId: "t-1",
      organizationName: "Org",
      apiKeyId: "k-1",
    } as never);
  });

  it("is registered", () => {
    const { server, handlers } = createMockServer();
    register(server, env);
    expect(handlers.has("sapiom_dev_orchestrations_clone")).toBe(true);
  });

  it("delegates to clone and returns the result with a next-steps hint", async () => {
    vi.mocked(clone).mockResolvedValue({
      forkId: "fork-1",
      templateId: "web-research-digest",
      repoFullName: "Sapiom-Platform/sapiom-fork-abc",
      defaultBranch: "main",
      targetDir: "/tmp/proj",
      tokenExpiresAt: "2026-07-07T01:00:00.000Z",
    });
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_orchestrations_clone")!({
      dir: "/tmp/proj",
      templateId: "web-research-digest",
    });

    expect(clone).toHaveBeenCalledWith(
      {
        templateId: "web-research-digest",
        forkId: undefined,
        targetDir: "/tmp/proj",
      },
      expect.anything(),
    );
    const out = parse(res);
    expect(out.forkId).toBe("fork-1");
    expect(out.hint).toContain("sapiom_dev_orchestrations_link");
    // The credential must never surface in the tool output.
    expect(res.content[0].text).not.toContain("x-access-token");
  });

  it("returns a structured error when not authenticated", async () => {
    vi.mocked(readCredentials).mockResolvedValue(null as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_orchestrations_clone")!({
      dir: "/tmp/proj",
      forkId: "f",
    });

    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe("NOT_AUTHENTICATED");
    expect(clone).not.toHaveBeenCalled();
  });

  it("surfaces a core error (e.g. bad input) as a tool error", async () => {
    const { OrchestrationError } = await import("@sapiom/orchestration-core");
    vi.mocked(clone).mockRejectedValue(
      new OrchestrationError({
        code: "BAD_INPUT",
        message: "Provide only one of templateId or forkId, not both.",
      }),
    );
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_orchestrations_clone")!({
      dir: "/tmp/proj",
      templateId: "t",
      forkId: "f",
    });

    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe("BAD_INPUT");
  });
});
