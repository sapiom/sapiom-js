/**
 * Wiring-level regression for the Canvas cloud-status badge. The SPA routes
 * already receive definition metadata through enrichWorkflows(); this proves
 * the real POST /api/canvas/:sessionId/render path receives the same mutable
 * active-build projection instead of the raw workflow registry snapshot.
 */
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderFileFor } from "../core/canvas-render.js";
import type {
  HarnessAdapter,
  LaunchOpts,
  SpawnSpec,
  WorkflowInfo,
} from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

const BOOT_TOKEN = "test-token";
const ORDER_TRIAGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../core/__fixtures__/order-triage",
);

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

describe("Canvas build-status wiring", () => {
  let tempDir: string;
  let harness: HarnessServer | undefined;
  let definitionsApi: HttpServer | undefined;
  let previousAgentsUrl: string | undefined;
  let definitionRequests: number;
  let definitionStatus = 200;
  let definitionBody: unknown;
  let holdDefinition: ((url: string) => Promise<void>) | null = null;
  let definitionApiKeys: Array<string | undefined>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-canvas-build-status-"),
    );
    previousAgentsUrl = process.env.SAPIOM_AGENTS_URL;
    definitionRequests = 0;
    definitionStatus = 200;
    definitionBody = {
      slug: "order-triage",
      activeBuildRunId: "build-ready-1",
      activeBuildRunStatus: "ready",
    };
    holdDefinition = null;
    definitionApiKeys = [];

    definitionsApi = createHttpServer(async (req, res) => {
      if (!/^\/agents\/v1\/definitions\/482[12]$/.test(req.url ?? "")) {
        res.writeHead(404).end();
        return;
      }
      definitionRequests += 1;
      definitionApiKeys.push(
        req.headers["x-sapiom-api-key"] as string | undefined,
      );
      const status = definitionStatus;
      const body = definitionBody;
      await holdDefinition?.(req.url!);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => {
      definitionsApi!.listen(0, "127.0.0.1", resolve);
    });
    const address = definitionsApi.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.SAPIOM_AGENTS_URL = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await harness?.sessionManager.flush();
    await harness?.close();
    harness = undefined;
    if (definitionsApi) {
      await new Promise<void>((resolve) =>
        definitionsApi!.close(() => resolve()),
      );
      definitionsApi = undefined;
    }
    if (previousAgentsUrl === undefined) delete process.env.SAPIOM_AGENTS_URL;
    else process.env.SAPIOM_AGENTS_URL = previousAgentsUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("renders a ready linked workflow as deployed through the live server path", async () => {
    const stateRoot = path.join(tempDir, "state");
    const sessionDir = path.join(tempDir, "session");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    const secondAgent = path.join(tempDir, "other-agent");
    await fs.mkdir(secondAgent);
    await fs.writeFile(
      path.join(stateRoot, "workflows.json"),
      JSON.stringify([
        {
          name: "order-triage",
          path: ORDER_TRIAGE,
          definitionId: 4821,
          definitionSlug: null,
          source: "connect",
        },
        {
          name: "other-agent",
          path: secondAgent,
          definitionId: 4822,
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
      // This test exercises Canvas's cloud-status request, not the default
      // launch builder. Keep its synthetic boot identity in memory without a
      // real ~/.sapiom credential fixture for launch-time reconciliation.
      buildLaunchOpts: () => ({}),
      stateRoot,
      launchDir: sessionDir,
      autoCreateSession: false,
    });
    const session = await harness.sessionManager.create({
      cwd: sessionDir,
      harness: "claude-code",
    });
    harness.sessionManager.setBoundWorkflowPath(session.id, ORDER_TRIAGE);

    const response = await fetch(
      `http://127.0.0.1:${harness.port}/api/canvas/${session.id}/render`,
      {
        method: "POST",
        headers: { "X-Harness-Token": BOOT_TOKEN },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, mode: "single" });
    expect(definitionRequests).toBe(1);
    expect(definitionApiKeys).toEqual(["sk-test"]);
    await expect(
      fs.readFile(renderFileFor(sessionDir, ORDER_TRIAGE), "utf8"),
    ).resolves.toContain(">deployed<");

    const request = (route: string, method = "GET") =>
      fetch(`http://127.0.0.1:${harness!.port}/api/${route}`, {
        method,
        headers: { "X-Harness-Token": BOOT_TOKEN },
      });
    const rows = async (route: string): Promise<WorkflowInfo[]> => {
      const response = await request(route);
      expect(response.status).toBe(200);
      const body = await response.json();
      return route === "state" ? body.workflows : body;
    };
    const readyRows = await rows("state");
    expect(readyRows[0].deploymentLookup).toEqual({
      lastConfirmedDeployed: true,
      unavailable: false,
    });
    definitionStatus = 503;
    definitionBody = { message: "private upstream diagnostic" };
    for (const route of ["state", "workflows"]) {
      const unavailable = await rows(route);
      expect(unavailable[0]).toMatchObject({
        activeBuildRunId: null,
        activeBuildRunStatus: null,
        deploymentLookup: { lastConfirmedDeployed: true, unavailable: true },
      });
      expect(JSON.stringify(unavailable)).not.toContain(
        "private upstream diagnostic",
      );
    }
    definitionStatus = 404;
    definitionBody = {
      statusCode: 404,
      message: "Agent definition not found: 4821",
    };
    expect(
      (await rows("workflows")).find((row) => row.definitionId === 4821)
        ?.deploymentLookup,
    ).toEqual({
      lastConfirmedDeployed: false,
      unavailable: false,
    });
    expect(
      await fs.readFile(path.join(stateRoot, "workflows.json"), "utf8"),
    ).not.toContain("deploymentLookup");

    // A request started under the old identity must not return ready after logout.
    definitionStatus = 200;
    definitionBody = {
      slug: "old-account-agent",
      activeBuildRunId: "late-build",
      activeBuildRunStatus: "ready",
    };
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    holdDefinition = (url) =>
      url.endsWith("4821")
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            release = resolve;
            entered();
          });
    const pending = rows("state");
    await started;
    expect((await request("auth/disconnect", "POST")).status).toBe(200);
    release();
    const afterAuth = await pending;
    expect(afterAuth).toHaveLength(2);
    for (const row of afterAuth)
      expect(row).toMatchObject({
        activeBuildRunId: null,
        activeBuildRunStatus: null,
        definitionSlug: null,
        deploymentLookup: { lastConfirmedDeployed: null, unavailable: true },
      });
  });
});
