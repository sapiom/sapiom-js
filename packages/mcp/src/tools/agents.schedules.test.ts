import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(),
}));

// Keep the real module (createClient, AgentOperationError, ...) but stub the networked
// schedule fns so the tools are tested without touching the backend.
vi.mock("@sapiom/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sapiom/agent-core")>();
  return {
    ...actual,
    createSchedule: vi.fn(),
    listSchedules: vi.fn(),
    getSchedule: vi.fn(),
    cancelSchedule: vi.fn(),
    previewCron: vi.fn(),
    rotateScheduleSecret: vi.fn(),
    completeScheduleSecretRotation: vi.fn(),
    revokeScheduleSecret: vi.fn(),
  };
});

import { register } from "./agents.js";
import { readCredentials } from "../credentials.js";
import {
  cancelSchedule,
  completeScheduleSecretRotation,
  createSchedule,
  getSchedule,
  listSchedules,
  previewCron,
  revokeScheduleSecret,
  rotateScheduleSecret,
} from "@sapiom/agent-core";

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

  it("registers the 5 trigger tools", () => {
    const { server, handlers } = createMockServer();
    register(server, env);
    for (const name of [
      "sapiom_dev_agents_schedule",
      "sapiom_dev_agents_schedule_inspect",
      "sapiom_dev_agents_schedule_cancel",
      "sapiom_dev_agents_schedule_secret",
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
      expect.objectContaining({
        definition: "enrich",
        kind: "schedule_cron",
        cron: "0 9 * * *",
      }),
      expect.anything(),
    );
    const out = parse(res);
    expect(out.schedule.id).toBe("trig-1");
    expect(out.hint).toContain("next fire at");
    expect(out.webhook).toBeUndefined();
  });

  it("schedule tool offers all four backend trigger kinds (SAP-3174)", () => {
    // The gap this closes: the enum said cron/once only, so an agent asked to run on an
    // inbound POST concluded nothing listens and proposed hand-building a server.
    const { server } = createMockServer();
    register(server, env);
    const call = vi
      .mocked(server.tool)
      .mock.calls.find((c) => c[0] === "sapiom_dev_agents_schedule")!;
    const schema = call[2] as unknown as {
      kind: { options: string[] };
      eventType: unknown;
    };
    expect(schema.kind.options).toEqual([
      "schedule_cron",
      "schedule_once",
      "event",
      "webhook",
    ]);
    expect(schema.eventType).toBeDefined();
    expect(call[1]).toContain("webhook");
    expect(call[1]).toContain("App Link");
  });

  it("event trigger create forwards eventType and hints at the emit route", async () => {
    vi.mocked(createSchedule).mockResolvedValue({
      id: "trig-2",
      kind: "event",
      status: "active",
      definitionSlug: "enrich",
      cron: null,
      timezone: null,
      eventType: "lead.created",
      publicId: null,
      secretVersion: null,
      graceUntil: null,
      revokedAt: null,
      nextFireAt: null,
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
      kind: "event",
      eventType: "lead.created",
    });

    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: "enrich",
        kind: "event",
        eventType: "lead.created",
      }),
      expect.anything(),
    );
    const out = parse(res);
    expect(out.schedule.eventType).toBe("lead.created");
    expect(out.hint).toContain("lead.created");
    expect(out.hint).toContain("/v1/workflows/events");
  });

  it("webhook trigger create returns the hook URL, the shown-once secret, and the signing scheme", async () => {
    vi.mocked(createSchedule).mockResolvedValue({
      id: "trig-3",
      kind: "webhook",
      status: "active",
      definitionSlug: "enrich",
      cron: null,
      timezone: null,
      eventType: null,
      publicId: "whk_abc",
      secretVersion: 1,
      graceUntil: null,
      revokedAt: null,
      nextFireAt: null,
      createdAt: "x",
      input: {},
      startAt: null,
      endAt: null,
      policy: null,
      recentFires: [],
      secret: "shh-once",
      url: "https://api.sapiom.ai/v1/workflows/hooks/whk_abc",
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_schedule")!({
      definition: "enrich",
      kind: "webhook",
    });

    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ definition: "enrich", kind: "webhook" }),
      expect.anything(),
    );
    const out = parse(res);
    // The secret leaves in the dedicated `webhook` block, never mixed into the detail object
    // that inspect later returns (inspect can never show it — it is derived, not stored).
    expect(out.schedule.secret).toBeUndefined();
    expect(out.webhook.url).toBe(
      "https://api.sapiom.ai/v1/workflows/hooks/whk_abc",
    );
    expect(out.webhook.secret).toBe("shh-once");
    expect(out.webhook.signing.algorithm).toContain("HMAC-SHA256");
    expect(out.webhook.signing.signedString).toBe(
      "<X-Sapiom-Timestamp>.<X-Sapiom-Event-Id>.<raw request body bytes>",
    );
    for (const h of [
      "X-Sapiom-Timestamp",
      "X-Sapiom-Event-Id",
      "X-Sapiom-Signature",
    ]) {
      expect(out.webhook.signing.headers[h]).toBeDefined();
    }
    expect(out.webhook.signing.thirdPartySenders).toContain("App Link");
    expect(out.hint).toContain("shown ONCE");
  });

  it("schedule_inspect on a webhook never carries a secret and explains how to recover one", async () => {
    vi.mocked(getSchedule).mockResolvedValue({
      id: "trig-3",
      kind: "webhook",
      status: "active",
      definitionSlug: "enrich",
      cron: null,
      timezone: null,
      eventType: null,
      publicId: "whk_abc",
      secretVersion: 2,
      graceUntil: null,
      revokedAt: null,
      nextFireAt: null,
      createdAt: "x",
      input: {},
      startAt: null,
      endAt: null,
      policy: null,
      recentFires: [],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_schedule_inspect")!({
      scheduleId: "trig-3",
    });

    const out = parse(res);
    expect(out.schedule.secret).toBeUndefined();
    expect(out.hint).toContain("whk_abc");
    expect(out.hint).toContain("sapiom_dev_agents_schedule_secret");
  });

  it("schedule_secret rotate returns the new secret once, with the URL and the grace window", async () => {
    vi.mocked(getSchedule).mockResolvedValue({
      id: "trig-3",
      kind: "webhook",
      secretVersion: 1,
    } as never);
    vi.mocked(rotateScheduleSecret).mockResolvedValue({
      id: "trig-3",
      kind: "webhook",
      status: "active",
      definitionSlug: "enrich",
      cron: null,
      timezone: null,
      eventType: null,
      publicId: "whk_abc",
      secretVersion: 2,
      graceUntil: "2026-09-05T12:00:00.000Z",
      revokedAt: null,
      nextFireAt: null,
      createdAt: "x",
      input: {},
      startAt: null,
      endAt: null,
      policy: null,
      recentFires: [],
      secret: "shh-v2",
      url: "https://api.sapiom.ai/v1/workflows/hooks/whk_abc",
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_schedule_secret")!({
      scheduleId: "trig-3",
      action: "rotate",
    });

    expect(rotateScheduleSecret).toHaveBeenCalledWith(
      "trig-3",
      expect.anything(),
    );
    const out = parse(res);
    expect(out.schedule.secret).toBeUndefined();
    expect(out.webhook.secret).toBe("shh-v2");
    expect(out.webhook.url).toContain("/hooks/whk_abc");
    expect(out.webhook.signing.algorithm).toContain("HMAC-SHA256");
    expect(out.hint).toContain("2026-09-05T12:00:00.000Z");
    expect(out.hint).toContain("complete_rotation");
    expect(out.replayed).toBe(false);
    expect(out.hint).toContain("Rotated to secret v2");
  });

  it("schedule_secret rotate says so when the engine replayed an in-progress rotation", async () => {
    // Grace still open → the engine returns the same version and the same secret rather than
    // minting another. The hint must not claim a new secret was minted.
    vi.mocked(getSchedule).mockResolvedValue({
      id: "trig-3",
      kind: "webhook",
      secretVersion: 2,
    } as never);
    vi.mocked(rotateScheduleSecret).mockResolvedValue({
      id: "trig-3",
      kind: "webhook",
      status: "active",
      secretVersion: 2,
      graceUntil: "2026-09-05T12:00:00.000Z",
      secret: "shh-v2",
      url: "https://api.sapiom.ai/v1/workflows/hooks/whk_abc",
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_schedule_secret")!({
      scheduleId: "trig-3",
      action: "rotate",
    });

    const out = parse(res);
    expect(out.replayed).toBe(true);
    expect(out.hint).toContain("No new secret");
    expect(out.hint).toContain("complete_rotation");
    expect(out.hint).not.toContain("Rotated to");
    expect(out.webhook.secret).toBe("shh-v2");
  });

  it("schedule_secret complete_rotation and revoke delegate to their core fns", async () => {
    vi.mocked(completeScheduleSecretRotation).mockResolvedValue({
      id: "trig-3",
      status: "active",
    } as never);
    vi.mocked(revokeScheduleSecret).mockResolvedValue({
      id: "trig-3",
      status: "disabled",
      revokedAt: "now",
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    await handlers.get("sapiom_dev_agents_schedule_secret")!({
      scheduleId: "trig-3",
      action: "complete_rotation",
    });
    expect(completeScheduleSecretRotation).toHaveBeenCalledWith(
      "trig-3",
      expect.anything(),
    );

    const res = await handlers.get("sapiom_dev_agents_schedule_secret")!({
      scheduleId: "trig-3",
      action: "revoke",
    });
    expect(revokeScheduleSecret).toHaveBeenCalledWith(
      "trig-3",
      expect.anything(),
    );
    expect(parse(res).hint).toContain("Revoked");
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
      recentFires: [
        {
          scheduledFor: "x",
          state: "failed",
          firedAt: "y",
          executionId: "exec-9",
          error: {},
        },
      ],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_schedule_inspect")!({
      scheduleId: "trig-1",
    });

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

    expect(listSchedules).toHaveBeenCalledWith(
      { definition: "enrich", status: "active" },
      expect.anything(),
    );
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
    vi.mocked(cancelSchedule).mockResolvedValue({
      id: "trig-1",
      status: "disabled",
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    await handlers.get("sapiom_dev_agents_schedule_cancel")!({
      scheduleId: "trig-1",
    });

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

    const res = await handlers.get("sapiom_dev_agents_cron_preview")!({
      cron: "0 9 * * *",
      count: 1,
    });

    expect(previewCron).toHaveBeenCalledWith(
      { cron: "0 9 * * *", timezone: undefined, count: 1 },
      expect.anything(),
    );
    expect(parse(res).occurrences).toHaveLength(1);
  });
});
