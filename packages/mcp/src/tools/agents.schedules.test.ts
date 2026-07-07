import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(),
}));

// Keep the real module (createClient, AgentOperationError, ...) but stub the networked
// schedule fns so the tools are tested without touching the backend.
vi.mock("@sapiom/orchestration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sapiom/orchestration-core")>();
  return {
    ...actual,
    createSchedule: vi.fn(),
    listSchedules: vi.fn(),
    getSchedule: vi.fn(),
    cancelSchedule: vi.fn(),
    previewCron: vi.fn(),
  };
});

import { register } from "./agents.js";
import { readCredentials } from "../credentials.js";
import {
  cancelSchedule,
  createSchedule,
  getSchedule,
  listSchedules,
  previewCron,
} from "@sapiom/orchestration-core";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer(): { server: McpServer; handlers: Map<string, ToolHandler> } {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((_name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      handlers.set(_name, handler);
    }),
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

const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);

describe("agent schedule MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readCredentials).mockResolvedValue({
      apiKey: "sk_test",
      tenantId: "t-1",
      organizationName: "Org",
      apiKeyId: "k-1",
    } as never);
  });

  it("registers the 4 schedule tools", () => {
    const { server, handlers } = createMockServer();
    register(server, env);
    for (const name of [
      "sapiom_dev_agents_schedule",
      "sapiom_dev_agents_schedule_inspect",
      "sapiom_dev_agents_schedule_cancel",
      "sapiom_dev_agents_cron_preview",
    ]) {
      expect(handlers.has(name)).toBe(true);
    }
  });

  it("schedule create delegates to createSchedule and adds a next-fire hint", async () => {
    vi.mocked(createSchedule).mockResolvedValue({
      id: "trig-1",
      kind: "schedule_cron",
      status: "active",
      definitionSlug: "enrich",
      cron: "0 9 * * *",
      timezone: "UTC",
      nextFireAt: "2026-07-01T09:00:00.000Z",
      createdAt: "x",
      input: {},
      startAt: null,
      endAt: null,
      policy: null,
      recentFires: [],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_schedule")!({
      definition: "enrich",
      kind: "schedule_cron",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ definition: "enrich", kind: "schedule_cron", cron: "0 9 * * *" }),
      expect.anything(),
    );
    const out = parse(res);
    expect(out.schedule.id).toBe("trig-1");
    expect(out.hint).toContain("next fire at");
  });

  it("schedule_inspect by id returns detail + a failure hint pointing at the failed run", async () => {
    vi.mocked(getSchedule).mockResolvedValue({
      id: "trig-1",
      kind: "schedule_cron",
      status: "active",
      definitionSlug: "enrich",
      cron: "* * * * *",
      timezone: "UTC",
      nextFireAt: "2026-07-01T09:00:00.000Z",
      createdAt: "x",
      input: {},
      startAt: null,
      endAt: null,
      policy: null,
      recentFires: [{ scheduledFor: "x", state: "failed", firedAt: "y", executionId: "exec-9", error: {} }],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_schedule_inspect")!({ scheduleId: "trig-1" });

    expect(getSchedule).toHaveBeenCalledWith("trig-1", expect.anything());
    expect(parse(res).hint).toContain("exec-9");
  });

  it("schedule_inspect by definition lists schedules", async () => {
    vi.mocked(listSchedules).mockResolvedValue([{ id: "trig-1" }] as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_schedule_inspect")!({
      definition: "enrich",
      status: "active",
    });

    expect(listSchedules).toHaveBeenCalledWith({ definition: "enrich", status: "active" }, expect.anything());
    expect(parse(res)).toEqual([{ id: "trig-1" }]);
  });

  it("schedule_inspect with neither id nor definition is an error", async () => {
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_schedule_inspect")!({});

    expect(res.isError).toBe(true);
    expect(getSchedule).not.toHaveBeenCalled();
    expect(listSchedules).not.toHaveBeenCalled();
  });

  it("schedule_cancel delegates to cancelSchedule", async () => {
    vi.mocked(cancelSchedule).mockResolvedValue({ id: "trig-1", status: "disabled" } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    await handlers.get("sapiom_dev_agents_schedule_cancel")!({ scheduleId: "trig-1" });

    expect(cancelSchedule).toHaveBeenCalledWith("trig-1", expect.anything());
  });

  it("cron_preview delegates to previewCron", async () => {
    vi.mocked(previewCron).mockResolvedValue({
      cron: "0 9 * * *",
      timezone: "UTC",
      occurrences: ["2026-07-01T09:00:00.000Z"],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_cron_preview")!({ cron: "0 9 * * *", count: 1 });

    expect(previewCron).toHaveBeenCalledWith({ cron: "0 9 * * *", timezone: undefined, count: 1 }, expect.anything());
    expect(parse(res).occurrences).toHaveLength(1);
  });
});
