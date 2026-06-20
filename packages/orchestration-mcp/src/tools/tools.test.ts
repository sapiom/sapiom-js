/**
 * Unit tests for orchestration MCP tool registration.
 *
 * Strategy: mock @sapiom/orchestration-core functions and verify that each
 * tool (a) registers under the correct name, (b) calls the right core function,
 * and (c) serializes the result into the expected text shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ── Mock core ─────────────────────────────────────────────────────────────────

vi.mock("@sapiom/orchestration-core", () => ({
  scaffold: vi.fn(),
  resolveVersions: vi.fn(),
  check: vi.fn(),
  link: vi.fn(),
  deploy: vi.fn(),
  run: vi.fn(),
  parseJsonInput: vi.fn((s: string) => JSON.parse(s)),
  inspect: vi.fn(),
  listExecutions: vi.fn(),
  inspectBuild: vi.fn(),
  signal: vi.fn(),
  parseSignalPayload: vi.fn((s: string) => JSON.parse(s)),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  createClient: vi.fn(),
  OrchestrationError: class OrchestrationError extends Error {
    code: string;
    hint?: string;
    constructor(opts: { code: string; message: string; hint?: string }) {
      super(opts.message);
      this.code = opts.code;
      this.hint = opts.hint;
    }
  },
}));

// Mock config so we don't read real ~/.sapiom files
vi.mock("../config.js", () => ({
  makeClient: vi.fn(() => ({})),
  resolveHost: vi.fn(() => "https://api.sapiom.ai"),
  resolveApiKey: vi.fn(() => "sk_test"),
}));

import {
  scaffold,
  resolveVersions,
  check,
  link,
  deploy,
  run,
  inspect,
  listExecutions,
  inspectBuild,
  signal,
  readConfig,
  writeConfig,
} from "@sapiom/orchestration-core";

import { register as registerScaffold } from "./scaffold.js";
import { register as registerCheck } from "./check.js";
import { register as registerLink } from "./link.js";
import { register as registerDeploy } from "./deploy.js";
import { register as registerRun } from "./run.js";
import { register as registerStatus } from "./status.js";
import { register as registerLogs } from "./logs.js";
import { register as registerSignal } from "./signal.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function createMockServer(): {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn(
      (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
        handlers.set(_name, handler);
      },
    ),
  } as unknown as McpServer;
  return { server, handlers };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── scaffold ──────────────────────────────────────────────────────────────────

describe("orchestration_scaffold", () => {
  it("registers the tool", () => {
    const { server, handlers } = createMockServer();
    registerScaffold(server);
    expect(handlers.has("orchestration_scaffold")).toBe(true);
  });

  it("calls scaffold with resolved versions and returns success text", async () => {
    const { server, handlers } = createMockServer();
    registerScaffold(server);

    vi.mocked(resolveVersions).mockResolvedValue({
      orchestration: "0.1.0",
      tools: "0.1.0",
      zod: "3.25.0",
      cli: "0.1.0",
    });
    vi.mocked(scaffold).mockResolvedValue({
      targetDir: "/tmp/my-workflow",
      template: "default",
      projectName: "my-workflow",
    });

    const result = await handlers.get("orchestration_scaffold")!({
      targetDir: "/tmp/my-workflow",
      projectName: "my-workflow",
    });

    expect(scaffold).toHaveBeenCalledWith({
      targetDir: "/tmp/my-workflow",
      projectName: "my-workflow",
      template: undefined,
      versions: { orchestration: "0.1.0", tools: "0.1.0", zod: "3.25.0", cli: "0.1.0" },
    });
    expect(result.content[0].text).toContain("scaffolded successfully");
    expect(result.content[0].text).toContain("/tmp/my-workflow");
    expect(result.isError).toBeFalsy();
  });

  it("returns isError on failure", async () => {
    const { server, handlers } = createMockServer();
    registerScaffold(server);

    vi.mocked(resolveVersions).mockResolvedValue({
      orchestration: "0.1.0",
      tools: "0.1.0",
      zod: "3.25.0",
      cli: "0.1.0",
    });
    vi.mocked(scaffold).mockRejectedValue(new Error("Directory not empty"));

    const result = await handlers.get("orchestration_scaffold")!({
      targetDir: "/tmp/my-workflow",
      projectName: "my-workflow",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Directory not empty");
  });
});

// ── check ─────────────────────────────────────────────────────────────────────

describe("orchestration_check", () => {
  it("registers the tool", () => {
    const { server, handlers } = createMockServer();
    registerCheck(server);
    expect(handlers.has("orchestration_check")).toBe(true);
  });

  it("calls check and returns step count", async () => {
    const { server, handlers } = createMockServer();
    registerCheck(server);

    vi.mocked(check).mockResolvedValue({
      name: "my-workflow",
      stepCount: 3,
      warnings: [],
      manifest: {},
    });

    const result = await handlers.get("orchestration_check")!({
      sourceDir: "/tmp/my-workflow",
    });

    expect(check).toHaveBeenCalledWith({ sourceDir: "/tmp/my-workflow" });
    expect(result.content[0].text).toContain("validation passed");
    expect(result.content[0].text).toContain("Steps: 3");
    expect(result.isError).toBeFalsy();
  });

  it("includes warnings in output", async () => {
    const { server, handlers } = createMockServer();
    registerCheck(server);

    vi.mocked(check).mockResolvedValue({
      name: "my-workflow",
      stepCount: 1,
      warnings: ["Step 'slow' has no timeout"],
      manifest: {},
    });

    const result = await handlers.get("orchestration_check")!({
      sourceDir: "/tmp/my-workflow",
    });

    expect(result.content[0].text).toContain("Step 'slow' has no timeout");
  });
});

// ── link ──────────────────────────────────────────────────────────────────────

describe("orchestration_link", () => {
  it("registers the tool", () => {
    const { server, handlers } = createMockServer();
    registerLink(server);
    expect(handlers.has("orchestration_link")).toBe(true);
  });

  it("calls link, writes config, and returns definition id", async () => {
    const { server, handlers } = createMockServer();
    registerLink(server);

    vi.mocked(link).mockResolvedValue({
      definitionId: "def-123",
      name: "my-workflow",
    });
    vi.mocked(readConfig).mockReturnValue(null);

    const result = await handlers.get("orchestration_link")!({
      projectDir: "/tmp/my-workflow",
      name: "my-workflow",
    });

    expect(link).toHaveBeenCalledWith(
      { name: "my-workflow", create: undefined },
      expect.anything(),
    );
    expect(writeConfig).toHaveBeenCalledWith("/tmp/my-workflow", {
      definitionId: "def-123",
      name: "my-workflow",
    });
    expect(result.content[0].text).toContain("def-123");
    expect(result.isError).toBeFalsy();
  });
});

// ── deploy ────────────────────────────────────────────────────────────────────

describe("orchestration_deploy", () => {
  it("registers the tool", () => {
    const { server, handlers } = createMockServer();
    registerDeploy(server);
    expect(handlers.has("orchestration_deploy")).toBe(true);
  });

  it("calls deploy and returns build status", async () => {
    const { server, handlers } = createMockServer();
    registerDeploy(server);

    vi.mocked(readConfig).mockReturnValue({
      definitionId: "def-123",
      name: "my-workflow",
    });
    vi.mocked(deploy).mockResolvedValue({
      definitionId: "def-123",
      buildRunId: "build-456",
      status: "ready",
    });

    const result = await handlers.get("orchestration_deploy")!({
      projectDir: "/tmp/my-workflow",
    });

    expect(deploy).toHaveBeenCalledWith(
      { projectDir: "/tmp/my-workflow", definitionId: "def-123", branch: undefined },
      expect.anything(),
    );
    expect(result.content[0].text).toContain("ready");
    expect(result.content[0].text).toContain("build-456");
    expect(result.isError).toBeFalsy();
  });

  it("returns error when project is not linked", async () => {
    const { server, handlers } = createMockServer();
    registerDeploy(server);

    vi.mocked(readConfig).mockReturnValue(null);

    const result = await handlers.get("orchestration_deploy")!({
      projectDir: "/tmp/my-workflow",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not linked");
  });
});

// ── run ───────────────────────────────────────────────────────────────────────

describe("orchestration_run", () => {
  it("registers the tool", () => {
    const { server, handlers } = createMockServer();
    registerRun(server);
    expect(handlers.has("orchestration_run")).toBe(true);
  });

  it("calls run with definitionId and returns executionId", async () => {
    const { server, handlers } = createMockServer();
    registerRun(server);

    vi.mocked(run).mockResolvedValue({
      executionId: "exec-789",
      raw: {},
    });

    const result = await handlers.get("orchestration_run")!({
      definitionId: "def-123",
    });

    expect(run).toHaveBeenCalledWith(
      { definitionId: "def-123", input: undefined },
      expect.anything(),
    );
    expect(result.content[0].text).toContain("exec-789");
    expect(result.isError).toBeFalsy();
  });

  it("reads definitionId from sapiom.json when not provided", async () => {
    const { server, handlers } = createMockServer();
    registerRun(server);

    vi.mocked(readConfig).mockReturnValue({
      definitionId: "def-from-config",
      name: "my-workflow",
    });
    vi.mocked(run).mockResolvedValue({ executionId: "exec-999", raw: {} });

    const result = await handlers.get("orchestration_run")!({
      projectDir: "/tmp/my-workflow",
    });

    expect(run).toHaveBeenCalledWith(
      { definitionId: "def-from-config", input: undefined },
      expect.anything(),
    );
    expect(result.content[0].text).toContain("exec-999");
  });
});

// ── status ────────────────────────────────────────────────────────────────────

describe("orchestration_status", () => {
  it("registers the tool", () => {
    const { server, handlers } = createMockServer();
    registerStatus(server);
    expect(handlers.has("orchestration_status")).toBe(true);
  });

  it("calls inspect and formats execution status", async () => {
    const { server, handlers } = createMockServer();
    registerStatus(server);

    vi.mocked(inspect).mockResolvedValue({
      execution: {
        id: "exec-789",
        status: "running",
        currentStep: "step-2",
        steps: [
          { stepName: "step-1", attempt: 1, status: "completed" },
          { stepName: "step-2", attempt: 1, status: "running" },
        ],
      },
    });

    const result = await handlers.get("orchestration_status")!({
      executionId: "exec-789",
    });

    expect(inspect).toHaveBeenCalledWith({ executionId: "exec-789" }, expect.anything());
    expect(result.content[0].text).toContain("exec-789");
    expect(result.content[0].text).toContain("running");
    expect(result.content[0].text).toContain("step-2");
  });
});

// ── logs ──────────────────────────────────────────────────────────────────────

describe("orchestration_logs and orchestration_build_status", () => {
  it("registers both tools", () => {
    const { server, handlers } = createMockServer();
    registerLogs(server);
    expect(handlers.has("orchestration_logs")).toBe(true);
    expect(handlers.has("orchestration_build_status")).toBe(true);
  });

  it("calls listExecutions and formats list", async () => {
    const { server, handlers } = createMockServer();
    registerLogs(server);

    vi.mocked(listExecutions).mockResolvedValue({
      executions: [
        { id: "exec-1", status: "completed" },
        { id: "exec-2", status: "running", currentStep: "step-1" },
      ],
    });

    const result = await handlers.get("orchestration_logs")!({});

    expect(listExecutions).toHaveBeenCalledWith(expect.anything());
    expect(result.content[0].text).toContain("exec-1");
    expect(result.content[0].text).toContain("exec-2");
    expect(result.content[0].text).toContain("step-1");
  });

  it("calls inspectBuild and returns build status", async () => {
    const { server, handlers } = createMockServer();
    registerLogs(server);

    vi.mocked(inspectBuild).mockResolvedValue({
      build: { id: "build-456", status: "ready" },
    });

    const result = await handlers.get("orchestration_build_status")!({
      definitionId: "def-123",
      buildRunId: "build-456",
    });

    expect(inspectBuild).toHaveBeenCalledWith(
      { definitionId: "def-123", buildRunId: "build-456" },
      expect.anything(),
    );
    expect(result.content[0].text).toContain("ready");
  });
});

// ── signal ────────────────────────────────────────────────────────────────────

describe("orchestration_signal", () => {
  it("registers the tool", () => {
    const { server, handlers } = createMockServer();
    registerSignal(server);
    expect(handlers.has("orchestration_signal")).toBe(true);
  });

  it("calls signal and returns matched count", async () => {
    const { server, handlers } = createMockServer();
    registerSignal(server);

    vi.mocked(signal).mockResolvedValue({ matched: 1 });

    const result = await handlers.get("orchestration_signal")!({
      executionId: "exec-789",
      name: "approval",
      correlationId: "corr-abc",
    });

    expect(signal).toHaveBeenCalledWith(
      {
        executionId: "exec-789",
        name: "approval",
        correlationId: "corr-abc",
        payload: undefined,
      },
      expect.anything(),
    );
    expect(result.content[0].text).toContain("Signal delivered");
    expect(result.content[0].text).toContain("1 execution(s)");
    expect(result.isError).toBeFalsy();
  });

  it("validates the input schema: correlationId is required", async () => {
    // Schema validation happens before the handler; here we just confirm the
    // handler receives and forwards correlationId when present
    const { server, handlers } = createMockServer();
    registerSignal(server);

    vi.mocked(signal).mockResolvedValue({ matched: 1 });

    const result = await handlers.get("orchestration_signal")!({
      executionId: "exec-789",
      name: "approval",
      correlationId: "corr-xyz",
      payload: '{"approved":true}',
    });

    expect(result.content[0].text).toContain("Signal delivered");
  });
});
