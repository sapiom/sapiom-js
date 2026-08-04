/**
 * sapiom_send_feedback — the tool's contract with the agent calling it.
 *
 * Two of these assertions are acceptance criteria rather than regressions, and
 * are asserted rather than eyeballed: the description and field descriptions
 * must forbid code and secrets, and `clientMeta` must carry only the allowlist
 * (no paths, no repo identity, no user content).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(),
}));

// Keep the real module — `AgentOperationError` must stay a real class so
// `fail()` produces the structured envelope — but stub the networked call.
vi.mock("@sapiom/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sapiom/agent-core")>();
  return { ...actual, sendFeedback: vi.fn(), createClient: vi.fn(() => ({})) };
});

vi.mock("../version.js", () => ({ packageVersion: () => "9.9.9" }));

import { register } from "./feedback.js";
import { readCredentials } from "../credentials.js";
import { AgentOperationError, createClient, sendFeedback } from "@sapiom/agent-core";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface Registration {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: ToolHandler;
}

function createMockServer(): {
  server: McpServer;
  registrations: Map<string, Registration>;
} {
  const registrations = new Map<string, Registration>();
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: Record<string, z.ZodTypeAny>,
        handler: ToolHandler,
      ) => {
        registrations.set(name, { name, description, schema, handler });
      },
    ),
  } as unknown as McpServer;
  return { server, registrations };
}

const TOOL = "sapiom_send_feedback";

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

const parse = (res: { content: Array<{ text: string }> }) =>
  JSON.parse(res.content[0].text);

function setup(overrides: Partial<ResolvedEnvironment> = {}): Registration {
  const { server, registrations } = createMockServer();
  register(server, { ...env, ...overrides });
  return registrations.get(TOOL)!;
}

/** The clientMeta the handler built on the last sendFeedback call. */
function lastMeta(): Record<string, unknown> {
  const [opts] = vi.mocked(sendFeedback).mock.calls[0];
  return opts.clientMeta as Record<string, unknown>;
}

describe("sapiom_send_feedback tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T10:00:00.000Z"));
    vi.mocked(readCredentials).mockResolvedValue({
      apiKey: "sk_test",
      tenantId: "t-1",
      organizationName: "Org",
      apiKeyId: "k-1",
    } as never);
    vi.mocked(sendFeedback).mockResolvedValue({ id: "fb_1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("registers under the documented name", () => {
    expect(setup().name).toBe(TOOL);
  });

  it("tells the agent when to reach for it and forbids code and secrets", () => {
    const { description } = setup();
    expect(description).toMatch(/feedback/i);
    expect(description).toMatch(/never/i);
    expect(description).toMatch(/secret/i);
    expect(description).toMatch(/code/i);
    // The clause that stops the model going to read version/OS off the machine.
    expect(description).toMatch(/attached automatically/i);
  });

  it("repeats the prohibition on the context field itself", () => {
    const { schema } = setup();
    expect(schema.context.description).toMatch(/never include/i);
    expect(schema.message.description).toMatch(/no code, logs, stack traces, or secrets/i);
  });

  it("requires a non-empty message and an optional string context", () => {
    const shape = z.object(setup().schema);
    expect(shape.safeParse({ message: "it broke" }).success).toBe(true);
    expect(shape.safeParse({ message: "it broke", context: "deploying" }).success).toBe(true);
    expect(shape.safeParse({ message: "" }).success).toBe(false);
    expect(shape.safeParse({}).success).toBe(false);
    expect(shape.safeParse({ message: "it broke", context: 1 }).success).toBe(false);
  });

  it("rejects a whitespace-only message and trims the rest", () => {
    const shape = z.object(setup().schema);
    expect(shape.safeParse({ message: "   " }).success).toBe(false);
    expect(shape.safeParse({ message: "\n\t " }).success).toBe(false);
    const parsed = shape.safeParse({ message: "  it broke  " });
    expect(parsed.success && parsed.data.message).toBe("it broke");
  });

  it("builds a client from the cached credential and the environment host", async () => {
    await setup().handler({ message: "it broke" });
    expect(createClient).toHaveBeenCalledWith({
      apiKey: "sk_test",
      host: "https://api.sapiom.ai",
    });
  });

  it("forwards the message and context the agent supplied", async () => {
    await setup().handler({ message: "it broke", context: "deploying an agent" });
    expect(vi.mocked(sendFeedback).mock.calls[0][0]).toMatchObject({
      message: "it broke",
      context: "deploying an agent",
    });
  });

  it("sends exactly message, context and clientMeta — nothing else", async () => {
    await setup().handler({ message: "it broke", context: "deploying" });
    expect(Object.keys(vi.mocked(sendFeedback).mock.calls[0][0]).sort()).toEqual([
      "clientMeta",
      "context",
      "message",
    ]);
  });

  it("leaves context undefined rather than sending an empty string", async () => {
    await setup().handler({ message: "it broke" });
    expect(vi.mocked(sendFeedback).mock.calls[0][0].context).toBeUndefined();
  });

  it("attaches exactly the client-meta allowlist", async () => {
    await setup().handler({ message: "it broke" });
    expect(lastMeta()).toEqual({
      client: "sapiom-mcp",
      clientVersion: "9.9.9",
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      environment: "production",
      sentAt: "2026-08-03T10:00:00.000Z",
    });
  });

  it("omits harnessVersion entirely when no harness advertises one", async () => {
    await setup().handler({ message: "it broke" });
    expect("harnessVersion" in lastMeta()).toBe(false);
  });

  it("includes harnessVersion when a harness advertises one", async () => {
    vi.stubEnv("SAPIOM_HARNESS_VERSION", "0.2.5");
    await setup().handler({ message: "it broke" });
    expect(lastMeta().harnessVersion).toBe("0.2.5");
  });

  it("reports the resolved environment name verbatim", async () => {
    const reg = setup({ name: "local", apiURL: "http://localhost:3000" });
    await reg.handler({ message: "it broke" });
    expect(lastMeta().environment).toBe("local");
    expect(createClient).toHaveBeenCalledWith({
      apiKey: "sk_test",
      host: "http://localhost:3000",
    });
  });

  it("confirms in prose, quoting the reference id", async () => {
    const res = await setup().handler({ message: "it broke" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Sapiom team");
    expect(res.content[0].text).toContain("fb_1");
  });

  it("still confirms when the response carries no id", async () => {
    vi.mocked(sendFeedback).mockResolvedValue({});
    const res = await setup().handler({ message: "it broke" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Sapiom team");
    expect(res.content[0].text).not.toContain("undefined");
  });

  it("routes an unauthenticated caller to sapiom_authenticate without calling out", async () => {
    vi.mocked(readCredentials).mockResolvedValue(null);
    const res = await setup().handler({ message: "it broke" });
    expect(res.isError).toBe(true);
    const { error } = parse(res);
    expect(error.code).toBe("NOT_AUTHENTICATED");
    expect(error.hint).toContain("sapiom_authenticate");
    expect(sendFeedback).not.toHaveBeenCalled();
  });

  it("relays a gateway error with its structured code and hint", async () => {
    vi.mocked(sendFeedback).mockRejectedValue(
      new AgentOperationError({
        code: "HTTP_401",
        message: "Unauthorized",
        hint: "Check your API key.",
      }),
    );
    const res = await setup().handler({ message: "it broke" });
    expect(res.isError).toBe(true);
    const { error } = parse(res);
    expect(error.code).toBe("HTTP_401");
    expect(error.hint).toBe("Check your API key.");
  });

  it("classifies an unexpected throw rather than crashing the server", async () => {
    vi.mocked(sendFeedback).mockRejectedValue(new Error("boom"));
    const res = await setup().handler({ message: "it broke" });
    expect(res.isError).toBe(true);
    const { error } = parse(res);
    expect(error.code).toBe("UNEXPECTED");
    expect(error.message).toBe("boom");
  });

  it("never echoes the API key, on either path", async () => {
    const okRes = await setup().handler({ message: "it broke" });
    expect(okRes.content[0].text).not.toContain("sk_test");

    // The thrown message deliberately does NOT contain the key: `fail()` relays
    // an error message verbatim, so seeding one with the key would make this
    // assertion pass for the wrong reason. What is under test is that the tool
    // does not add the credential it holds.
    vi.mocked(sendFeedback).mockRejectedValue(new Error("upstream refused"));
    const errRes = await setup().handler({ message: "it broke" });
    expect(errRes.isError).toBe(true);
    expect(errRes.content[0].text).not.toContain("sk_test");
  });
});
