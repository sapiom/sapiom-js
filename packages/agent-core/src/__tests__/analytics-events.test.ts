/**
 * End-to-end usage analytics for the orchestration operations, over the real
 * delivery path: the real emitter (`@sapiom/analytics-core`, endpoint via
 * SAPIOM_ANALYTICS_ENDPOINT) posting to a live in-process mock collector,
 * with a live fake gateway HTTP server behind GatewayClient. Only the git /
 * esbuild edges of deploy are mocked.
 *
 * Gates covered:
 *   - link → deploy → run emit `workflow.link` / `workflow.deploy` /
 *     `workflow.run` (source "orchestration") with ids, status, duration
 *   - runLocal emits `step.start` / `step.complete` / `step.error` flagged
 *     `local: true`
 *   - opt-out env vars → zero collector requests, identical results
 *   - fault injection (collector down / erroring / unconfigured) → identical
 *     orchestration behavior
 *   - payloads are metadata-only (no inputs, outputs, or error messages)
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildManifest,
  defineAgent,
  defineStep,
  goto,
  terminate,
  agentManifestSchema,
  type AgentDefinition,
  type AgentManifest,
} from "@sapiom/agent";
import type { MockCollector } from "@sapiom/analytics-core/testing";
import { startMockCollector } from "@sapiom/analytics-core/testing";

import {
  getOrchestrationAnalytics,
  resetOrchestrationAnalyticsForTesting,
} from "../analytics";
import { createClient } from "../client";
import { deploy } from "../deploy";
import { link } from "../link";
import { run } from "../run";
import { runLocal } from "../local/run-local";

// Deploy's git/esbuild edges are out of scope here — everything else
// (gateway HTTP calls, polling, analytics) runs for real.
jest.mock("../git", () => ({
  assertDeployable: jest.fn(),
  pushSynthesizedTree: jest.fn(),
}));
jest.mock("../bundle", () => ({
  bundleForDeploy: jest.fn(async () => ({
    code: "export {};",
    dependencies: {},
  })),
}));

// ── Local helpers ────────────────────────────────────────────────────────────

/** Sandbox the identity file (`~/.sapiom/analytics.json`) in a temp HOME. */
function useTempHome(): () => void {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapiom-agent-core-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  const realIdentityPath = path.join(os.homedir(), ".sapiom", "analytics.json");
  const realIdentityBefore = readFileOrNull(realIdentityPath);
  return () => {
    restoreEnvVar("HOME", previousHome);
    restoreEnvVar("USERPROFILE", previousUserProfile);
    fs.rmSync(dir, { recursive: true, force: true });
    if (readFileOrNull(realIdentityPath) !== realIdentityBefore) {
      throw new Error(
        `test escaped the temp HOME sandbox and modified ${realIdentityPath}`,
      );
    }
  };
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

const ANALYTICS_ENV_KEYS = [
  "SAPIOM_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "SAPIOM_ANALYTICS_ENDPOINT",
] as const;

/** Clear the analytics env vars; returns a restore fn. */
function stashAnalyticsEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of ANALYTICS_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of ANALYTICS_ENV_KEYS) restoreEnvVar(key, saved[key]);
  };
}

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

interface FakeGateway {
  host: string;
  close(): Promise<void>;
}

/**
 * A real HTTP server standing in for the workflows gateway, so GatewayClient
 * traffic and analytics delivery each use their own live socket (mocking
 * global fetch would swallow the collector traffic too). Routes are keyed
 * `"METHOD /path"` with paths relative to `/v1/workflows`.
 */
async function startFakeGateway(
  routes: Record<string, { status: number; body: unknown }>,
): Promise<FakeGateway> {
  const server = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      const routePath = (req.url ?? "").replace(/^\/v1\/workflows/, "");
      const route = routes[`${req.method} ${routePath}`];
      res.setHeader("content-type", "application/json");
      if (!route) {
        res.statusCode = 404;
        res.end(
          JSON.stringify({ message: `no route ${req.method} ${routePath}` }),
        );
        return;
      }
      res.statusCode = route.status;
      res.end(JSON.stringify(route.body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    host: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function manifestFor(def: AgentDefinition): AgentManifest {
  return agentManifestSchema.parse(
    buildManifest(def, {
      sdkVersion: "0.0.0-test",
      artifact: { sha256: "x", entryFile: "def.mjs" },
    }),
  ) as AgentManifest;
}

function twoStepDefinition(): AgentDefinition {
  const one = defineStep({
    name: "one",
    next: ["two"],
    async run() {
      return goto("two", { n: 1 });
    },
  });
  const two = defineStep({
    name: "two",
    next: [],
    terminal: true,
    async run() {
      return terminate({ ok: true });
    },
  });
  return defineAgent({ name: "local-wf", entry: "one", steps: { one, two } });
}

const HAPPY_ROUTES: Record<string, { status: number; body: unknown }> = {
  "GET /definitions": {
    status: 200,
    body: [{ id: "def_1", name: "my-workflow" }],
  },
  "POST /definitions/def_1/push-credentials": {
    status: 200,
    body: { pushUrl: "file:///tmp/unused.git" },
  },
  "POST /definitions/def_1/builds": {
    status: 200,
    body: { buildRunId: "build_1", status: "queued" },
  },
  "GET /definitions/def_1/builds/build_1": {
    status: 200,
    body: { status: "ready" },
  },
  "POST /executions": { status: 200, body: { executionId: "exec_1" } },
};

/** Run the full happy path: link → deploy → run. Returns the results. */
async function runHappyFlow(gatewayHost: string) {
  const client = createClient({ host: gatewayHost, apiKey: "sk_test" });
  const linked = await link({ name: "my-workflow" }, client);
  const deployed = await deploy(
    { projectDir: "/tmp/fake-project", definitionId: linked.definitionId },
    client,
  );
  const started = await run({ definitionId: linked.definitionId }, client);
  return { linked, deployed, started };
}

// ── Suite ────────────────────────────────────────────────────────────────────

let restoreHome: () => void;
let restoreEnv: () => void;
let collector: MockCollector;

beforeAll(() => {
  restoreHome = useTempHome();
});

afterAll(() => {
  restoreHome();
});

beforeEach(async () => {
  restoreEnv = stashAnalyticsEnv();
  collector = await startMockCollector();
  process.env.SAPIOM_ANALYTICS_ENDPOINT = collector.url;
  resetOrchestrationAnalyticsForTesting();
});

afterEach(async () => {
  await getOrchestrationAnalytics().shutdown();
  resetOrchestrationAnalyticsForTesting();
  await collector.close();
  restoreEnv();
});

describe("workflow lifecycle events (link → deploy → run)", () => {
  it("emits workflow.link / workflow.deploy / workflow.run with ids, status, duration", async () => {
    const gateway = await startFakeGateway(HAPPY_ROUTES);
    try {
      const { linked, deployed, started } = await runHappyFlow(gateway.host);

      // The operations themselves are unaffected by instrumentation.
      expect(linked).toEqual({ definitionId: "def_1", name: "my-workflow" });
      expect(deployed).toEqual({
        definitionId: "def_1",
        buildRunId: "build_1",
        status: "ready",
      });
      expect(started.executionId).toBe("exec_1");

      await getOrchestrationAnalytics().flush();
      const events = collector.events();
      expect(events.map((e) => e.event_type)).toEqual([
        "workflow.link",
        "workflow.deploy",
        "workflow.run",
      ]);

      for (const event of events) {
        expect(event.source).toBe("orchestration");
        expect(event.sdk_name).toBe("@sapiom/agent-core");
        expect(event.sdk_version).toMatch(/^\d+\.\d+\.\d+/);
        expect(typeof event.data.duration_ms).toBe("number");
        expect(event.data.status).toBe("success");
      }

      const [linkEvent, deployEvent, runEvent] = events;
      expect(linkEvent.data.workflow_id).toBe("def_1");
      expect(linkEvent.data.workflow_name).toBe("my-workflow");
      expect(deployEvent.data.workflow_id).toBe("def_1");
      expect(deployEvent.data.branch).toBe("main");
      expect(deployEvent.data.build_run_id).toBe("build_1");
      expect(deployEvent.data.build_status).toBe("ready");
      expect(runEvent.data.workflow_id).toBe("def_1");
      expect(runEvent.data.execution_id).toBe("exec_1");
    } finally {
      await gateway.close();
    }
  });

  it("failed operations emit status=error with a machine-readable code and rethrow unchanged", async () => {
    const gateway = await startFakeGateway({
      "GET /definitions": { status: 200, body: [] }, // link: nothing to find
      "POST /executions": { status: 401, body: { message: "Unauthorized" } },
    });
    try {
      const client = createClient({ host: gateway.host, apiKey: "sk_bad" });

      await expect(link({ name: "ghost" }, client)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        run({ definitionId: "def_1" }, client),
      ).rejects.toMatchObject({ code: "HTTP_401" });

      await getOrchestrationAnalytics().flush();
      const events = collector.events();
      expect(events.map((e) => [e.event_type, e.data.status])).toEqual([
        ["workflow.link", "error"],
        ["workflow.run", "error"],
      ]);
      expect(events[0].data.error_code).toBe("NOT_FOUND");
      expect(events[0].data.workflow_name).toBe("ghost");
      expect(events[1].data.error_code).toBe("HTTP_401");
      // Codes only — the error message never rides along.
      for (const event of events) {
        expect(JSON.stringify(event.data)).not.toContain("Unauthorized");
      }
    } finally {
      await gateway.close();
    }
  });
});

describe("local run step events", () => {
  it("emits step.start/step.complete per step, flagged local: true", async () => {
    const def = twoStepDefinition();
    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
    });
    expect(result.outcome).toBe("completed");

    await getOrchestrationAnalytics().flush();
    const events = collector.events();
    expect(events.map((e) => [e.event_type, e.data.step])).toEqual([
      ["step.start", "one"],
      ["step.complete", "one"],
      ["step.start", "two"],
      ["step.complete", "two"],
    ]);
    for (const event of events) {
      expect(event.source).toBe("orchestration");
      expect(event.data.local).toBe(true);
      expect(event.data.workflow_name).toBe("local-wf");
      expect(event.data.execution_id).toBe(result.executionId);
    }
    for (const finish of events.filter(
      (e) => e.event_type === "step.complete",
    )) {
      expect(typeof finish.data.duration_ms).toBe("number");
      expect(finish.data.duration_ms as number).toBeGreaterThanOrEqual(0);
    }
  });

  it("emits step.error with the error class name when a step throws", async () => {
    const boom = defineStep({
      name: "boom",
      next: [],
      terminal: true,
      async run() {
        throw new Error("user-specific failure detail");
      },
    });
    const def = defineAgent({
      name: "local-fail",
      entry: "boom",
      steps: { boom },
    });

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
      maxAttemptsPerStep: 1,
    });
    expect(result.outcome).toBe("failed");

    await getOrchestrationAnalytics().flush();
    const events = collector.events();
    expect(events.map((e) => e.event_type)).toEqual([
      "step.start",
      "step.error",
    ]);
    expect(events[1].data.error_name).toBe("Error");
    expect(events[1].data.local).toBe(true);
    // The error message (user content) never rides along.
    expect(JSON.stringify(events[1].data)).not.toContain(
      "user-specific failure detail",
    );
  });
});

describe("consent and ship-dark", () => {
  it.each(["SAPIOM_TELEMETRY_DISABLED", "DO_NOT_TRACK"])(
    "%s=1 → zero collector requests, identical results",
    async (envVar) => {
      process.env[envVar] = "1";
      resetOrchestrationAnalyticsForTesting();

      const gateway = await startFakeGateway(HAPPY_ROUTES);
      try {
        const { linked, deployed, started } = await runHappyFlow(gateway.host);
        expect(linked.definitionId).toBe("def_1");
        expect(deployed.status).toBe("ready");
        expect(started.executionId).toBe("exec_1");

        const local = await runLocal({
          definition: twoStepDefinition(),
          manifest: manifestFor(twoStepDefinition()),
          input: {},
        });
        expect(local.outcome).toBe("completed");

        await getOrchestrationAnalytics().flush();
        expect(collector.requests).toHaveLength(0);
      } finally {
        await gateway.close();
      }
    },
  );

  it("no endpoint configured (ships dark) → zero requests, identical results", async () => {
    delete process.env.SAPIOM_ANALYTICS_ENDPOINT;
    resetOrchestrationAnalyticsForTesting();

    const gateway = await startFakeGateway(HAPPY_ROUTES);
    try {
      const { started } = await runHappyFlow(gateway.host);
      expect(started.executionId).toBe("exec_1");
      expect(getOrchestrationAnalytics().enabled).toBe(false);

      await getOrchestrationAnalytics().flush();
      expect(collector.requests).toHaveLength(0);
    } finally {
      await gateway.close();
    }
  });
});

describe("fault injection: collector failures never change orchestration behavior", () => {
  it.each([
    ["down", { kind: "down" } as const],
    ["erroring (500)", { kind: "status", status: 500 } as const],
  ])("collector %s → identical results, no throws", async (_label, mode) => {
    collector.setMode(mode);

    const gateway = await startFakeGateway(HAPPY_ROUTES);
    try {
      const { linked, deployed, started } = await runHappyFlow(gateway.host);
      expect(linked).toEqual({ definitionId: "def_1", name: "my-workflow" });
      expect(deployed).toEqual({
        definitionId: "def_1",
        buildRunId: "build_1",
        status: "ready",
      });
      expect(started.executionId).toBe("exec_1");

      const local = await runLocal({
        definition: twoStepDefinition(),
        manifest: manifestFor(twoStepDefinition()),
        input: {},
      });
      expect(local.outcome).toBe("completed");
      expect(local.steps.map((s) => [s.step, s.status])).toEqual([
        ["one", "succeeded"],
        ["two", "succeeded"],
      ]);

      // Delivery fails silently; flush must still resolve.
      await getOrchestrationAnalytics().flush();
    } finally {
      await gateway.close();
    }
  });
});
