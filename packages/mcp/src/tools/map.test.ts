import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(),
}));

vi.mock("@sapiom/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sapiom/agent-core")>();
  return { ...actual, listSchedules: vi.fn() };
});

import { accountPlatform, register } from "./map.js";
import { readCredentials } from "../credentials.js";
import { listSchedules, type GatewayClient } from "@sapiom/agent-core";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

const PAYOUTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../map/__fixtures__/map-payouts");

function mapTool(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    }),
  } as unknown as McpServer;
  register(server, env);
  return handlers.get("sapiom_dev_map")!;
}

const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0]!.text);

describe("sapiom_dev_map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readCredentials).mockResolvedValue(null);
  });

  it("maps a caller's own description without scanning", async () => {
    const res = await mapTool()({
      agents: [
        { slug: "intake", emits: [{ eventType: "ticket.opened" }] },
        { slug: "triage", triggers: [{ kind: "event", eventType: "ticket.opened", source: "code" }] },
        { slug: "digest" },
      ],
    });

    expect(res.isError).toBeUndefined();
    const map = parse(res);
    expect(map.root).toBeNull();
    expect(map.platform).toBe("skipped");
    expect(map.systems.map((system: { agents: string[] }) => system.agents)).toEqual([["intake", "triage"]]);
  });

  it("refuses both inputs at once", async () => {
    const res = await mapTool()({ root: PAYOUTS, agents: [{ slug: "a" }] });

    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe("INVALID_INPUT");
  });

  it("scans a folder signed out, and says the platform facts are missing", async () => {
    const res = await mapTool()({ root: PAYOUTS });

    const map = parse(res);
    expect(map.platform).toBe("signed-out");
    expect(map.systems.map((system: { agents: string[] }) => system.agents)).toEqual([["award", "payout"]]);
    expect(map.agents.find((agent: { slug: string }) => agent.slug === "dashboard").stepsUnavailable).toBe("steps not requested");
  });

  describe("step execution (SAP-4381)", () => {
    async function markerProject(): Promise<{ root: string; marker: string }> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "sapiom-map-tool-"));
      temps.push(root);
      const marker = path.join(root, "ran.txt");
      await fs.writeFile(path.join(root, "sapiom.json"), '{ "name": "loud" }');
      await fs.writeFile(
        path.join(root, "index.ts"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
      );
      return { root, marker };
    }
    const temps: string[] = [];
    afterEach(async () => {
      await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it("runs no project code by default", async () => {
      const { root, marker } = await markerProject();

      const map = parse(await mapTool()({ root }));

      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(map.agents.map((agent: { stepsUnavailable?: string }) => agent.stepsUnavailable)).toEqual([
        "steps not requested",
      ]);
    });

    it("runs the agents' code only with steps: true", async () => {
      const { root, marker } = await markerProject();

      await mapTool()({ root, steps: true });

      expect(await fs.readFile(marker, "utf8")).toBe("ran");
    }, 60_000);

    it("says in its description that steps: true runs the project's code", () => {
      const descriptions = new Map<string, string>();
      const server = {
        tool: vi.fn((name: string, description: string) => descriptions.set(name, description)),
      } as unknown as McpServer;
      register(server, env);

      expect(descriptions.get("sapiom_dev_map")).toMatch(/steps: true`, which imports and runs every discovered agent's code/);
    });
  });

  it("skips the account when platform is false, even when signed in", async () => {
    vi.mocked(readCredentials).mockResolvedValue({ apiKey: "sk_test" } as never);

    const map = parse(await mapTool()({ root: PAYOUTS, platform: false }));

    expect(map.platform).toBe("skipped");
    expect(readCredentials).not.toHaveBeenCalled();
  });

  describe("Jev labels", () => {
    const agents = [
      { slug: "intake", description: "Turns a customer's Slack message into a ticket.", emits: [{ eventType: "ticket.opened" }] },
      {
        slug: "triage",
        description: "Classifies each new ticket and assigns it.",
        triggers: [{ kind: "event", eventType: "ticket.opened", source: "code" }],
      },
    ];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { questions: Record<string, { criteria: Record<string, string> }> };
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([key, question]) => {
          const choice = Object.keys(question.criteria)[0]!;
          return [key, { type: "choice", choice, probabilities: { [choice]: 0.97 } }];
        }),
      );
      return new Response(JSON.stringify({ answers }), { status: 201 });
    });

    beforeEach(() => {
      fetchMock.mockClear();
      vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("asks Jev once when signed in, pinned to jev-1.13.0, and answers again from the cache", async () => {
      vi.mocked(readCredentials).mockResolvedValue({ apiKey: "sk_test" } as never);
      const tool = mapTool();

      const map = parse(await tool({ agents }));
      expect(map.labels).toBe("ok");
      expect(map.agents.map((agent: { role?: unknown }) => agent.role)).toEqual([
        { value: "intake", p: 0.97 },
        { value: "intake", p: 0.97 },
      ]);
      expect(map.edges[0].label).toEqual({ value: "hands work to", p: 0.97 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.sapiom.ai/v1/capabilities/decisions.evaluate");
      expect(JSON.parse(init.body).model).toBe("jev-1.13.0");

      expect(parse(await tool({ agents }))).toEqual(map);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("draws the map without labels when Jev fails", async () => {
      vi.mocked(readCredentials).mockResolvedValue({ apiKey: "sk_test" } as never);
      fetchMock.mockResolvedValueOnce(new Response("{}", { status: 502 }));

      const map = parse(await mapTool()({ agents }));
      expect(map.labels).toBe("unavailable");
      expect(map.agents.every((agent: { role?: unknown }) => agent.role === undefined)).toBe(true);
      expect(map.systems).toHaveLength(1);
    });

    it("makes no Jev call signed out or with platform false", async () => {
      expect(parse(await mapTool()({ agents })).labels).toBe("unavailable");
      vi.mocked(readCredentials).mockResolvedValue({ apiKey: "sk_test" } as never);
      expect(parse(await mapTool()({ agents, platform: false })).labels).toBe("unavailable");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("expands a leading ~ in root", async () => {
    const res = await mapTool()({ root: "~/definitely-not-a-sapiom-project-dir", platform: false });

    expect(parse(res).error.message).toContain(os.homedir());
  });

  it("answers a missing folder with a coded error", async () => {
    const res = await mapTool()({ root: path.join(PAYOUTS, "nope") });

    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe("NOT_A_DIRECTORY");
  });
});

describe("accountPlatform", () => {
  it("reads deployed slugs from /definitions and keeps only event and cron triggers", async () => {
    const client = {
      get: vi.fn().mockResolvedValue([{ id: "1", name: "Award", slug: "award" }, { id: "2", name: "payout" }]),
    } as unknown as GatewayClient;
    vi.mocked(listSchedules).mockResolvedValue([
      { kind: "event", eventType: "payout.sent" },
      { kind: "schedule_cron", cron: "0 9 * * 1" },
      { kind: "schedule_once" },
      { kind: "webhook" },
    ] as never);
    const platform = accountPlatform(client);

    expect([...(await platform.deployedSlugs())].sort()).toEqual(["Award", "award", "payout"]);
    expect(await platform.triggers("award")).toEqual([
      { kind: "event", eventType: "payout.sent", source: "platform" },
      { kind: "schedule", cron: "0 9 * * 1", source: "platform" },
    ]);
    expect(listSchedules).toHaveBeenCalledWith({ definition: "award", status: "active" }, client);
  });
});

describe("accountPlatform cache", () => {
  it("answers one account from cache for 30 s and never caches a failure", async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue([{ id: "1", name: "a" }]);
    const client = { get } as unknown as GatewayClient;
    const key = `test-${Math.random()}`;

    await expect(accountPlatform(client, { cacheKey: key }).deployedSlugs()).rejects.toThrow("ECONNRESET");
    await accountPlatform(client, { cacheKey: key }).deployedSlugs();
    await accountPlatform(client, { cacheKey: key }).deployedSlugs();
    expect(get).toHaveBeenCalledTimes(2);

    await accountPlatform(client).deployedSlugs();
    expect(get).toHaveBeenCalledTimes(3);
  });
});

