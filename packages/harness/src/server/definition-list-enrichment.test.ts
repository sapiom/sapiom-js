/**
 * Wiring regression for SAP-3214: one tenant-scoped list request per pass,
 * never a by-id request for a definition the account can't see. Fake Agents
 * API counting list and detail requests; `@sapiom/mcp/auth` mocked so the
 * disconnect route never touches ~/.sapiom.
 */
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsFilePath } from "@sapiom/mcp/auth";

vi.mock("@sapiom/mcp/auth", () => ({
  credentialsFilePath: vi.fn(),
  resolveEnvironment: vi.fn(async (environment?: string) => ({
    name: environment === "dev" ? "staging" : "production",
    appURL: "https://app.example.test",
    apiURL: "https://api.example.test",
    services: {},
    credentials: null,
  })),
  readCredentials: vi.fn(async () => null),
  readCredentialsOrThrow: vi.fn(async () => null),
  performBrowserAuth: vi.fn(async () => {
    throw new Error("browser auth is not part of this test");
  }),
  writeCredentials: vi.fn(async () => {}),
  clearCredentials: vi.fn(async () => {}),
}));

import type {
  HarnessAdapter,
  LaunchOpts,
  SpawnSpec,
  WorkflowInfo,
} from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

const BOOT_TOKEN = "test-token";
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../core/__fixtures__",
);
const OWN_PROJECT = path.join(FIXTURES, "order-triage");
const FOREIGN_PROJECT = path.join(FIXTURES, "hub");
const OWN_ID = 4821;
const FOREIGN_ID = 9999;

function fakeClaudeAdapter(): HarnessAdapter {
  const spec = (opts: LaunchOpts): SpawnSpec => ({
    command: "bash",
    args: [],
    env: {},
    cwd: opts.cwd,
  });
  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: spec,
    resume: (_agentSessionId: string, opts: LaunchOpts): SpawnSpec =>
      spec(opts),
    listPastSessions: async () => [],
    canResume: async () => true,
  };
}

interface FakeAgentsApi {
  listStatus: number;
  listRows: unknown;
  /** Detail bodies by definition id; an id without one answers 404. */
  detailBodies: Record<string, unknown>;
  listRequests: number;
  listApiKeys: Array<string | undefined>;
  detailRequests: Map<string, number>;
  reset(): void;
}

describe("definition list enrichment wiring (SAP-3214)", () => {
  let tempDir: string;
  let harness: HarnessServer | undefined;
  let agentsApi: HttpServer | undefined;
  let previousAgentsUrl: string | undefined;
  let api: FakeAgentsApi;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-definition-list-enrichment-"),
    );
    vi.mocked(credentialsFilePath).mockReturnValue(
      path.join(tempDir, "credentials.json"),
    );
    previousAgentsUrl = process.env.SAPIOM_AGENTS_URL;
    api = {
      listStatus: 200,
      listRows: [],
      detailBodies: {},
      listRequests: 0,
      listApiKeys: [],
      detailRequests: new Map(),
      reset() {
        this.listRequests = 0;
        this.listApiKeys = [];
        this.detailRequests = new Map();
      },
    };

    agentsApi = createHttpServer((req, res) => {
      if (req.url === "/agents/v1/definitions") {
        api.listRequests += 1;
        api.listApiKeys.push(
          req.headers["x-sapiom-api-key"] as string | undefined,
        );
        res.writeHead(api.listStatus, { "Content-Type": "application/json" });
        res.end(
          api.listStatus === 200
            ? JSON.stringify(api.listRows)
            : JSON.stringify({ error: "list unavailable" }),
        );
        return;
      }
      const detail = /^\/agents\/v1\/definitions\/([^/?]+)$/.exec(
        req.url ?? "",
      );
      if (detail) {
        const id = decodeURIComponent(detail[1]!);
        api.detailRequests.set(id, (api.detailRequests.get(id) ?? 0) + 1);
        const body = api.detailBodies[id];
        if (body === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => {
      agentsApi!.listen(0, "127.0.0.1", resolve);
    });
    const address = agentsApi.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.SAPIOM_AGENTS_URL = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await harness?.sessionManager.flush();
    await harness?.close();
    harness = undefined;
    if (agentsApi) {
      await new Promise<void>((resolve) => agentsApi!.close(() => resolve()));
      agentsApi = undefined;
    }
    if (previousAgentsUrl === undefined) delete process.env.SAPIOM_AGENTS_URL;
    else process.env.SAPIOM_AGENTS_URL = previousAgentsUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Two linked rows: one the account owns, one linked under another account. */
  async function bootHarness(): Promise<HarnessServer> {
    const stateRoot = path.join(tempDir, "state");
    const launchDir = path.join(tempDir, "launch");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.mkdir(launchDir, { recursive: true });
    await fs.writeFile(
      path.join(stateRoot, "workflows.json"),
      JSON.stringify([
        {
          name: "order-triage",
          path: OWN_PROJECT,
          definitionId: OWN_ID,
          definitionSlug: null,
          source: "connect",
        },
        {
          name: "hub",
          path: FOREIGN_PROJECT,
          definitionId: FOREIGN_ID,
          definitionSlug: null,
          source: "connect",
        },
      ]),
    );
    harness = await startServer({
      port: 0,
      bootToken: BOOT_TOKEN,
      telemetryOptIn: false,
      identity: {
        userId: "user-test",
        tenantId: "tenant-test",
        organizationName: "Test Org",
        apiKey: "sk-test",
        source: "cached",
      },
      adapters: { "claude-code": fakeClaudeAdapter() },
      buildLaunchOpts: () => ({}),
      stateRoot,
      launchDir,
      autoCreateSession: false,
    });
    return harness;
  }

  async function fetchWorkflows(
    server: HarnessServer,
    route: "/api/state" | "/api/workflows",
  ): Promise<Record<number, WorkflowInfo>> {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
      headers: { "X-Harness-Token": BOOT_TOKEN },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as
      | WorkflowInfo[]
      | { workflows: WorkflowInfo[] };
    const workflows = Array.isArray(body) ? body : body.workflows;
    const byId: Record<number, WorkflowInfo> = {};
    for (const workflow of workflows) {
      if (workflow.definitionId != null) byId[workflow.definitionId] = workflow;
    }
    return byId;
  }

  const detailTotal = (): number =>
    [...api.detailRequests.values()].reduce((sum, n) => sum + n, 0);

  it("issues one list request per pass and never asks for an id the account cannot see", async () => {
    api.listRows = [
      {
        id: String(OWN_ID),
        slug: "order-triage",
        activeBuildRunId: "build-1",
        activeBuildRunStatus: "ready",
      },
    ];
    const server = await bootHarness();

    const rows = await fetchWorkflows(server, "/api/state");

    expect(api.listRequests).toBe(1);
    expect(api.listApiKeys).toEqual(["sk-test"]);
    expect(detailTotal()).toBe(0);
    expect(rows[OWN_ID]).toMatchObject({
      definitionAccess: "visible",
      definitionSlug: "order-triage",
      activeBuildRunId: "build-1",
      activeBuildRunStatus: "ready",
      deploymentLookup: { lastConfirmedDeployed: true, unavailable: false },
    });
    expect(rows[FOREIGN_ID]).toMatchObject({
      definitionAccess: "unavailable",
      definitionSlug: null,
      deploymentLookup: { lastConfirmedDeployed: false, unavailable: false },
    });
    expect(rows[FOREIGN_ID]!.activeBuildRunStatus ?? null).toBeNull();

    // /api/workflows runs the same pass: one more list, still no detail.
    const again = await fetchWorkflows(server, "/api/workflows");
    expect(api.listRequests).toBe(2);
    expect(detailTotal()).toBe(0);
    expect(again[FOREIGN_ID]?.definitionAccess).toBe("unavailable");
  });

  it("leaves rows untouched, with no per-id fallback, when the list is unavailable", async () => {
    api.listStatus = 500;
    const server = await bootHarness();

    const rows = await fetchWorkflows(server, "/api/state");

    expect(api.listRequests).toBe(1);
    expect(detailTotal()).toBe(0);
    for (const id of [OWN_ID, FOREIGN_ID]) {
      expect(rows[id]).toBeDefined();
      expect(rows[id]!.definitionAccess).toBeUndefined();
      expect(rows[id]!.definitionSlug).toBeNull();
      // Nothing was ever confirmed for this account: no retained display bit.
      expect(rows[id]!.deploymentLookup).toEqual({
        lastConfirmedDeployed: null,
        unavailable: true,
      });
    }
  });

  it("asks the detail only for a visible definition with no ready build yet, to surface its first deploy", async () => {
    api.listRows = [
      {
        id: String(OWN_ID),
        slug: "order-triage",
        activeBuildRunId: null,
        activeBuildRunStatus: null,
      },
    ];
    api.detailBodies[String(OWN_ID)] = {
      id: String(OWN_ID),
      slug: "order-triage",
      activeBuildRunId: "build-2",
      activeBuildRunStatus: "building",
    };
    const server = await bootHarness();

    const rows = await fetchWorkflows(server, "/api/state");

    expect(api.listRequests).toBe(1);
    expect(api.detailRequests.get(String(OWN_ID))).toBe(1);
    expect(detailTotal()).toBe(1);
    expect(rows[OWN_ID]).toMatchObject({
      definitionAccess: "visible",
      definitionSlug: "order-triage",
      activeBuildRunId: "build-2",
      activeBuildRunStatus: "building",
      deploymentLookup: { lastConfirmedDeployed: false, unavailable: false },
    });
    expect(rows[FOREIGN_ID]?.definitionAccess).toBe("unavailable");
  });

  it("stops requesting anything once the account disconnects, with no restart", async () => {
    api.listRows = [
      {
        id: String(OWN_ID),
        slug: "order-triage",
        activeBuildRunId: "build-1",
        activeBuildRunStatus: "ready",
      },
    ];
    const server = await bootHarness();
    expect(
      (await fetchWorkflows(server, "/api/state"))[OWN_ID]?.definitionAccess,
    ).toBe("visible");
    api.reset();

    const disconnect = await fetch(
      `http://127.0.0.1:${server.port}/api/auth/disconnect`,
      { method: "POST", headers: { "X-Harness-Token": BOOT_TOKEN } },
    );
    expect(disconnect.status).toBe(200);

    const rows = await fetchWorkflows(server, "/api/state");

    expect(api.listRequests).toBe(0);
    expect(detailTotal()).toBe(0);
    for (const id of [OWN_ID, FOREIGN_ID]) {
      expect(rows[id]!.definitionAccess).toBeUndefined();
      expect(rows[id]!.deploymentLookup).toEqual({
        lastConfirmedDeployed: null,
        unavailable: true,
      });
    }
  });
});
