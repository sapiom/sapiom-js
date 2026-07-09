/**
 * End-to-end analytics tests: spawn the BUILT stdio server (`dist/index.js`,
 * the `sapiom-mcp` bin) as a real child process, drive it with a real MCP
 * client over stdio, and assert on the envelopes an in-process mock collector
 * receives — the full path a published install exercises.
 *
 * Requires `dist/` to exist (`pnpm --filter @sapiom/mcp build`); CI builds
 * before testing. Each server gets a throwaway HOME with a credentials file
 * whose apiURL points at a closed local port, so nothing here touches the
 * network beyond 127.0.0.1.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  startMockCollector,
  type MockCollector,
} from "@sapiom/analytics-core/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "index.js");

const E2E_API_KEY = "sk-e2e-analytics";

/** Every tool the server registers, sorted — an over-the-wire registration guard. */
const ALL_TOOL_NAMES = [
  "sapiom_authenticate",
  "sapiom_dev_agents_check",
  "sapiom_dev_agents_clone",
  "sapiom_dev_agents_cron_preview",
  "sapiom_dev_agents_deploy",
  "sapiom_dev_agents_inspect",
  "sapiom_dev_agents_link",
  "sapiom_dev_agents_run",
  "sapiom_dev_agents_run_local",
  "sapiom_dev_agents_scaffold",
  "sapiom_dev_agents_schedule",
  "sapiom_dev_agents_schedule_cancel",
  "sapiom_dev_agents_schedule_inspect",
  "sapiom_dev_agents_signal",
  "sapiom_logout",
  "sapiom_status",
];

/**
 * A throwaway HOME containing a credentials file for a hermetic "e2e"
 * environment: the apiURL is a closed local port (the instructions fetch
 * fails instantly and falls back to the bundled copy), and the cached
 * credential's API key should surface as the collector's x-sapiom-api-key.
 */
function writeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sapiom-mcp-e2e-"));
  fs.mkdirSync(path.join(home, ".sapiom"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".sapiom", "credentials.json"),
    JSON.stringify(
      {
        currentEnvironment: "e2e",
        environments: {
          e2e: {
            appURL: "http://127.0.0.1:9999",
            apiURL: "http://127.0.0.1:9",
            credentials: {
              apiKey: E2E_API_KEY,
              tenantId: "t-e2e",
              organizationName: "E2E Org",
              apiKeyId: "k-e2e",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return home;
}

interface SpawnedServer {
  client: Client;
  home: string;
}

/** Spawn `dist/index.js` over stdio with an explicit (minimal) environment. */
async function spawnServer(
  extraEnv: Record<string, string>,
): Promise<SpawnedServer> {
  const home = writeTempHome();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      HOME: home,
      USERPROFILE: home,
      SAPIOM_ENVIRONMENT: "e2e",
      ...extraEnv,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "analytics-e2e", version: "0.0.0" });
  await client.connect(transport);
  return { client, home };
}

async function closeServer(server: SpawnedServer): Promise<void> {
  try {
    await server.client.close();
  } finally {
    fs.rmSync(server.home, { recursive: true, force: true });
  }
}

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as unknown as ToolResult;
}

/** Poll until `count` tool.call events have arrived (batches may split). */
async function waitForToolCallEvents(
  collector: MockCollector,
  count: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const arrived = () =>
    collector.events().filter((e) => e.event_type === "tool.call").length;
  while (arrived() < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("analytics e2e (real stdio server)", () => {
  it(
    "emits tool.call envelopes for real tool invocations",
    { timeout: 30_000 },
    async () => {
      const collector = await startMockCollector();
      const server = await spawnServer({
        SAPIOM_ANALYTICS_ENDPOINT: collector.url,
      });
      try {
        const { tools } = await server.client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOL_NAMES);

        const statusResult = await callTool(server.client, "sapiom_status");
        expect(statusResult.content[0].text).toContain(
          "Authenticated as E2E Org",
        );

        const missingDir = path.join(server.home, "does-not-exist");
        const checkResult = await callTool(
          server.client,
          "sapiom_dev_agents_check",
          { dir: missingDir },
        );
        expect(checkResult.isError).toBe(true);

        await waitForToolCallEvents(collector, 2, 15_000);
        const events = collector
          .events()
          .filter((e) => e.event_type === "tool.call");
        expect(events).toHaveLength(2);

        const statusEvent = events.find((e) => e.data.tool === "sapiom_status");
        expect(statusEvent).toBeDefined();
        expect(statusEvent!.source).toBe("mcp");
        expect(statusEvent!.sdk_name).toBe("@sapiom/mcp");
        expect(statusEvent!.sdk_version).toMatch(/^\d+\.\d+\.\d+/);
        expect(statusEvent!.data.ok).toBe(true);
        expect(statusEvent!.data.args).toEqual({});
        expect(typeof statusEvent!.data.duration_ms).toBe("number");
        expect(statusEvent!.event_id).toBeTruthy();
        expect(statusEvent!.anonymous_id).toBeTruthy();

        const checkEvent = events.find(
          (e) => e.data.tool === "sapiom_dev_agents_check",
        );
        expect(checkEvent).toBeDefined();
        expect(checkEvent!.data.ok).toBe(false);
        expect(typeof checkEvent!.data.error_class).toBe("string");
        expect((checkEvent!.data.error_class as string).length).toBeGreaterThan(
          0,
        );
        // Sapiom-bound tools capture arguments in full.
        expect((checkEvent!.data.args as { dir?: string }).dir).toBe(missingDir);

        // Both events share the server process's session.
        expect(checkEvent!.session_id).toBe(statusEvent!.session_id);

        // The cached credential's API key rode along for enrichment.
        const request = collector.requests[0];
        expect(request.path).toBe("/v1/analytics/collector");
        expect(request.headers["x-sapiom-api-key"]).toBe(E2E_API_KEY);
      } finally {
        await closeServer(server);
        await collector.close();
      }
    },
  );

  it(
    "opt-out env vars produce zero collector requests while tools still work",
    { timeout: 30_000 },
    async () => {
      const collector = await startMockCollector();
      const servers = await Promise.all([
        spawnServer({
          SAPIOM_ANALYTICS_ENDPOINT: collector.url,
          SAPIOM_TELEMETRY_DISABLED: "1",
        }),
        spawnServer({
          SAPIOM_ANALYTICS_ENDPOINT: collector.url,
          DO_NOT_TRACK: "1",
        }),
      ]);
      try {
        for (const server of servers) {
          const result = await callTool(server.client, "sapiom_status");
          expect(result.content[0].text).toContain("Authenticated as E2E Org");
        }

        // One shared negative window comfortably past the 3s flush interval.
        await expect(collector.waitForRequests(1, 4_500)).rejects.toThrow();
        expect(collector.requests).toHaveLength(0);
      } finally {
        for (const server of servers) await closeServer(server);
        await collector.close();
      }
    },
  );

  it(
    "tool results are identical across collector down/500/slow, telemetry disabled, and analytics unreachable",
    { timeout: 60_000 },
    async () => {
      // A fixed path (not under the per-server temp HOME) so error payloads
      // are comparable across servers.
      const missingDir = path.join(
        os.tmpdir(),
        "sapiom-mcp-e2e-never-created",
        "project",
      );

      const collector = await startMockCollector();
      const healthy = await spawnServer({
        SAPIOM_ANALYTICS_ENDPOINT: collector.url,
      });
      const disabled = await spawnServer({
        SAPIOM_ANALYTICS_ENDPOINT: collector.url,
        SAPIOM_TELEMETRY_DISABLED: "1",
      });
      // Live-default with a permanently-refused endpoint (port 9 = discard).
      // Telemetry is enabled (no opt-out), delivery fails silently — tool
      // results must be identical whether analytics succeeds or fails.
      const refused = await spawnServer({
        SAPIOM_ANALYTICS_ENDPOINT: "http://127.0.0.1:9/v1/analytics/collector",
      });
      try {
        const snapshot = async (client: Client) => ({
          status: await callTool(client, "sapiom_status"),
          check: await callTool(client, "sapiom_dev_agents_check", {
            dir: missingDir,
          }),
        });

        const baseline = await snapshot(healthy.client);
        expect(baseline.status.content[0].text).toContain(
          "Authenticated as E2E Org",
        );
        expect(baseline.check.isError).toBe(true);

        // Fault injection: the collector misbehaves, tool results do not move.
        collector.setMode({ kind: "down" });
        expect(await snapshot(healthy.client)).toEqual(baseline);

        collector.setMode({ kind: "status", status: 500 });
        expect(await snapshot(healthy.client)).toEqual(baseline);

        collector.setMode({ kind: "slow", delayMs: 300 });
        expect(await snapshot(healthy.client)).toEqual(baseline);

        // Telemetry disabled and analytics-unreachable servers behave identically.
        expect(await snapshot(disabled.client)).toEqual(baseline);
        expect(await snapshot(refused.client)).toEqual(baseline);
      } finally {
        await closeServer(healthy);
        await closeServer(disabled);
        await closeServer(refused);
        await collector.close();
      }
    },
  );
});
