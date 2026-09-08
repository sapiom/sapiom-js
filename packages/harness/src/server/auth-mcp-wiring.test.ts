/**
 * Lifecycle-level regression coverage for SAP-3114.
 *
 * These tests boot the real server and exercise the shared launch builder used
 * by interactive create/resume and headless background tasks. OAuth and the
 * credential store are in-memory fakes; adapters inspect the generated config
 * synchronously before launching local throwaway processes. Nothing opens a
 * browser or contacts a Sapiom environment.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFixture = vi.hoisted(() => ({
  credential: null as null | {
    apiKey: string;
    tenantId: string;
    organizationName: string;
    apiKeyId: string;
  },
  readError: null as Error | null,
  browserResult: {
    apiKey: "browser-key",
    tenantId: "browser-tenant",
    organizationName: "Browser Org",
    apiKeyId: "browser-key-id",
  },
}));

vi.mock("@sapiom/mcp/auth", () => {
  const resolveEnvironment = vi.fn(async (environment?: string) => {
    const requested = environment ?? "production";
    const name =
      requested === "prod"
        ? "production"
        : requested === "dev"
          ? "staging"
          : requested;
    if (name !== "production" && name !== "staging") {
      throw new Error(`Unknown environment "${name}"`);
    }
    const production = name === "production";
    return {
      name,
      appURL: production
        ? "https://app.example.test"
        : "https://app.staging.example.test",
      apiURL: production
        ? "https://api.example.test"
        : "https://api.staging.example.test",
      services: {},
      credentials: authFixture.credential,
    };
  });

  return {
    resolveEnvironment,
    readCredentials: vi.fn(async () => authFixture.credential),
    readCredentialsOrThrow: vi.fn(async () => {
      if (authFixture.readError) throw authFixture.readError;
      return authFixture.credential;
    }),
    performBrowserAuth: vi.fn(async () => ({ ...authFixture.browserResult })),
    writeCredentials: vi.fn(
      async (
        _environment: string,
        _appURL: string,
        _apiURL: string,
        credential: NonNullable<typeof authFixture.credential>,
      ) => {
        authFixture.credential = { ...credential };
      },
    ),
    clearCredentials: vi.fn(async () => {
      authFixture.credential = null;
    }),
  };
});

import {
  clearCredentials,
  performBrowserAuth,
  readCredentialsOrThrow,
  resolveEnvironment,
  writeCredentials,
} from "@sapiom/mcp/auth";
import { startServer, type HarnessServer } from "./index.js";
import type { HarnessAdapter, LaunchOpts, SpawnSpec } from "../shared/types.js";

type LaunchKind = "create" | "resume" | "background";

interface CapturedLaunch {
  kind: LaunchKind;
  remote: {
    type: string;
    url: string;
    headers?: Record<string, string>;
  };
}

function capturingClaudeAdapter(captures: CapturedLaunch[]): HarnessAdapter {
  const capture = (kind: LaunchKind, opts: LaunchOpts): void => {
    if (!opts.mcpConfigFile) throw new Error("expected an MCP config file");
    const config = JSON.parse(readFileSync(opts.mcpConfigFile, "utf-8")) as {
      mcpServers: { sapiom: CapturedLaunch["remote"] };
    };
    captures.push({ kind, remote: config.mcpServers.sapiom });
  };
  const interactiveSpec = (
    kind: "create" | "resume",
    opts: LaunchOpts,
  ): SpawnSpec => {
    capture(kind, opts);
    return { command: "bash", args: [], env: {}, cwd: opts.cwd };
  };

  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: (opts) => interactiveSpec("create", opts),
    resume: (_agentSessionId, opts) => interactiveSpec("resume", opts),
    launchTask: (opts) => {
      capture("background", opts);
      return {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: {},
        cwd: opts.cwd,
      };
    },
    listPastSessions: async () => [],
    canResume: async () => true,
  };
}

function credential(
  apiKey: string,
): NonNullable<typeof authFixture.credential> {
  return {
    apiKey,
    tenantId: "test-tenant",
    organizationName: "Test Org",
    apiKeyId: "test-key-id",
  };
}

function injectedKey(capture: CapturedLaunch): string | undefined {
  return capture.remote.headers?.["x-api-key"];
}

describe("Agent Studio MCP authentication wiring", () => {
  const originalEnvironment = process.env.SAPIOM_ENVIRONMENT;
  let root: string;
  let projectRoot: string;
  let server: HarnessServer | undefined;
  let captures: CapturedLaunch[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-auth-mcp-wiring-"));
    projectRoot = join(root, "project");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "sapiom.json"),
      JSON.stringify({ definitionId: null }),
    );
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "auth-wiring-fixture" }),
    );
    delete process.env.SAPIOM_ENVIRONMENT;
    authFixture.credential = null;
    authFixture.readError = null;
    captures = [];
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await server?.sessionManager.flush();
    await server?.close();
    await server?.sessionManager.flush();
    server = undefined;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
    if (originalEnvironment === undefined) {
      delete process.env.SAPIOM_ENVIRONMENT;
    } else {
      process.env.SAPIOM_ENVIRONMENT = originalEnvironment;
    }
  });

  async function boot(
    options: Pick<
      Parameters<typeof startServer>[0],
      "identity" | "authMode"
    > = {},
  ): Promise<HarnessServer> {
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      autoCreateSession: false,
      stateRoot: root,
      launchDir: projectRoot,
      adapters: { "claude-code": capturingClaudeAdapter(captures) },
      loadSystemPrompt: async () => "test system prompt",
      ...options,
    });
    return server;
  }

  async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${server!.port}${path}`, {
      method: "POST",
      headers: {
        "x-harness-token": "test-token",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("injects a credential obtained through Studio login into the next session", async () => {
    await boot();

    const login = await post("/api/auth/start");
    expect(login.status).toBe(200);
    await vi.waitFor(() => expect(writeCredentials).toHaveBeenCalledOnce());

    await server!.sessionManager.create({
      cwd: projectRoot,
      harness: "claude-code",
    });

    expect(captures).toHaveLength(1);
    expect(captures[0].kind).toBe("create");
    expect(injectedKey(captures[0])).toBe("browser-key");
  });

  it("adopts a credential written externally after boot", async () => {
    await boot();
    authFixture.credential = credential("external-key");

    await server!.sessionManager.create({
      cwd: projectRoot,
      harness: "claude-code",
    });

    expect(injectedKey(captures[0])).toBe("external-key");
  });

  it("refreshes create, resume, and background launches while preserving the last key on read failure", async () => {
    authFixture.credential = credential("key-a");
    await boot({
      identity: {
        userId: "test-tenant",
        tenantId: "test-tenant",
        organizationName: "Test Org",
        apiKey: "key-a",
        source: "cached",
      },
    });

    const session = await server!.sessionManager.create({
      cwd: projectRoot,
      harness: "claude-code",
    });
    expect(injectedKey(captures.at(-1)!)).toBe("key-a");
    expect(
      await server!.sessionManager.setAgentSessionId(
        session.id,
        "agent-session-1",
      ),
    ).toBe(true);

    authFixture.credential = credential("key-b");
    await server!.sessionManager.kill(session.id);
    await server!.sessionManager.resume(session.id);
    expect(captures.at(-1)!.kind).toBe("resume");
    expect(injectedKey(captures.at(-1)!)).toBe("key-b");

    const taskResponse = await post("/api/macros/describe/run", {
      harnessSessionId: session.id,
      workflowPath: projectRoot,
      subject: "Describe this fixture",
    });
    expect(taskResponse.status).toBe(200);
    expect(captures.at(-1)!.kind).toBe("background");
    expect(injectedKey(captures.at(-1)!)).toBe("key-b");

    authFixture.readError = new Error("temporary credential-store failure");
    await server!.sessionManager.create({
      cwd: projectRoot,
      harness: "claude-code",
    });
    expect(injectedKey(captures.at(-1)!)).toBe("key-b");

    authFixture.readError = null;
    authFixture.credential = null;
    await server!.sessionManager.create({
      cwd: projectRoot,
      harness: "claude-code",
    });
    expect(captures.at(-1)!.remote.headers).toBeUndefined();
  }, 20_000);

  it("treats disabled auth as a hard process-wide opt-out", async () => {
    authFixture.credential = credential("cached-key");
    await boot({
      authMode: "disabled",
      identity: {
        userId: "test-tenant",
        tenantId: "test-tenant",
        organizationName: "Test Org",
        apiKey: "boot-key",
        source: "cached",
      },
    });

    await server!.sessionManager.create({
      cwd: projectRoot,
      harness: "claude-code",
    });
    expect(captures[0].remote.headers).toBeUndefined();
    expect(readCredentialsOrThrow).not.toHaveBeenCalled();

    vi.mocked(resolveEnvironment).mockClear();
    const status = await fetch(
      `http://127.0.0.1:${server!.port}/api/auth/status`,
      { headers: { "x-harness-token": "test-token" } },
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      authenticated: false,
      organizationName: null,
    });

    expect((await post("/api/auth/start")).status).toBe(403);
    expect((await post("/api/auth/disconnect")).status).toBe(403);
    expect(resolveEnvironment).not.toHaveBeenCalled();
    expect(performBrowserAuth).not.toHaveBeenCalled();
    expect(clearCredentials).not.toHaveBeenCalled();
  });
});
