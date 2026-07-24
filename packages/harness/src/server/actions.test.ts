import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createActionsRouter,
  resolveRunLocalBootstrapPath,
  type ActionsRouterOpts,
  type RunLocalChildProcess,
} from "./actions.js";
import type { ApiKeyProvider } from "../core/api-key-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a set of fake core deps. Every op is a spy so tests can assert it was
 * (or was not) called; none of them touch git or the network. `createClient`
 * returns an opaque sentinel — the fakes ignore it, they only care it was made
 * from the right host/key.
 */
function makeCoreDeps(overrides: Partial<ActionsRouterOpts["coreDeps"]> = {}) {
  const client = { __fake: true };
  return {
    createClient: vi.fn().mockReturnValue(client),
    deploy: vi.fn(),
    run: vi.fn(),
    readConfig: vi.fn().mockReturnValue({ definitionId: "def_123" }),
    // link: by default returns the same id already in config (no rewrite needed).
    link: vi.fn().mockResolvedValue({ definitionId: "def_123", name: "test-agent" }),
    // check: returns a name so resolveAgentName can avoid a basename fallback.
    check: vi.fn().mockResolvedValue({ name: "test-agent", stepCount: 1, warnings: [], manifest: {} }),
    writeConfig: vi.fn(),
    ...overrides,
  } as NonNullable<ActionsRouterOpts["coreDeps"]> & { __client?: unknown };
}

/** Parse an NDJSON body into an array of decoded objects. */
function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * A provider whose refresh() swaps to `refreshedKey` exactly once — the same
 * shape runs.test.ts uses. Records refresh() calls so a test can assert the
 * router refreshed at most once. Passing this as `apiKey` (rather than a plain
 * string) is exactly what the real server does.
 */
function refreshingProvider(
  initialKey: string | null,
  refreshedKey: string | null,
): ApiKeyProvider & { refreshCalls: number } {
  let current = initialKey;
  let refreshed = false;
  const provider = {
    refreshCalls: 0,
    getKey: () => current,
    refresh: () => {
      provider.refreshCalls += 1;
      if (!refreshed) {
        refreshed = true;
        current = refreshedKey;
      }
      return Promise.resolve(current);
    },
    clear: () => {
      current = null;
    },
  };
  return provider;
}

/** An agent-core auth rejection (what a 401/403 upstream surfaces as). */
async function makeAuthRejection(status: 401 | 403): Promise<Error> {
  const { AgentOperationError } = await import("@sapiom/agent-core");
  return new AgentOperationError({
    code: `HTTP_${status}`,
    message: "Unauthorized.",
    hint: "check your key", // must never leak to the browser
  });
}

/**
 * A scripted stand-in for the run-local bootstrap child. `stdout`/`stderr` are
 * real streams the test pushes lines into; `exit`/`error` are emitted via the
 * inner emitter. `stdinChunks` records what the route wrote so a test can
 * assert the request was forwarded. No real process is ever spawned.
 */
class FakeChild extends EventEmitter implements RunLocalChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinChunks: string[] = [];
  readonly stdin = new (class extends PassThrough {
    constructor(private readonly parent: FakeChild) {
      super();
    }
    override end(chunk?: unknown): this {
      if (typeof chunk === "string") this.parent.stdinChunks.push(chunk);
      return this;
    }
  })(this);

  /** Emit a line on stdout (the route reads it via readline). */
  emitLine(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }
  /** Emit raw text on stdout (for the non-JSON-noise case). */
  emitRaw(text: string): void {
    this.stdout.write(text);
  }
  /** Close stdout then signal process exit. */
  finish(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    // Let the readline "line" handlers drain before the exit handler runs.
    setImmediate(() => this.emit("exit", code));
  }
}

/**
 * A `runLocalSpawn` seam that hands back a {@link FakeChild} and a `whenSpawned`
 * promise, so a test can await "the route has spawned the child and attached
 * its stdout/exit/error listeners" before driving it — deterministic instead of
 * racing on `setImmediate` against the HTTP round-trip.
 */
function spawnFake(): {
  child: FakeChild;
  spawn: () => FakeChild;
  whenSpawned: Promise<FakeChild>;
} {
  const child = new FakeChild();
  let resolve!: (c: FakeChild) => void;
  const whenSpawned = new Promise<FakeChild>((r) => (resolve = r));
  const spawn = (): FakeChild => {
    // Resolve on the next tick so the route finishes wiring listeners first.
    setImmediate(() => resolve(child));
    return child;
  };
  return { child, spawn, whenSpawned };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createActionsRouter", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;

  function start(opts: ActionsRouterOpts) {
    const app = express();
    app.use(express.json());
    app.use(createActionsRouter(opts));
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── POST /api/workflows/:id/deploy ────────────────────────────────────────

  describe("POST /api/workflows/:id/deploy", () => {
    it("streams building then ready NDJSON on a successful deploy", async () => {
      const coreDeps = makeCoreDeps({
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_123",
          buildRunId: "build_9",
          status: "ready",
        }),
      });
      start({
        apiKey: "sk-test-key",
        coreBaseUrl: "https://api.test",
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");

      const events = parseNdjson(await res.text());
      expect(events).toEqual([
        { phase: "building", definitionId: "def_123" },
        {
          phase: "ready",
          definitionId: "def_123",
          buildRunId: "build_9",
          status: "ready",
        },
      ]);

      // Deploy was called server-side with the resolved project dir + def id,
      // and the client was minted from the configured host + held key.
      expect(coreDeps.deploy).toHaveBeenCalledWith(
        { projectDir: "/proj/agent", definitionId: "def_123" },
        expect.anything(),
      );
      expect(coreDeps.createClient).toHaveBeenCalledWith({
        host: "https://api.test",
        apiKey: "sk-test-key",
      });
    });

    it("streams a terminal error line (still HTTP 200) when the build fails", async () => {
      // Import the real error type so the router's instanceof branch is exercised.
      const { AgentOperationError } = await import("@sapiom/agent-core");
      const coreDeps = makeCoreDeps({
        deploy: vi.fn().mockRejectedValue(
          new AgentOperationError({
            code: "BUILD_FAILED",
            message: "Build failed.",
            step: "build",
            hint: "traceback here",
          }),
        ),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const events = parseNdjson(await res.text());
      expect(events[0]).toEqual({ phase: "building", definitionId: "def_123" });
      // The hint is forwarded — it is safe because git errors are redacted at
      // source (credentials stripped before reaching the hint field).
      expect(events[1]).toEqual({
        phase: "error",
        code: "BUILD_FAILED",
        message: "Build failed.",
        hint: "traceback here",
      });
    });

    it("returns 400 when the workflow id is empty", async () => {
      const coreDeps = makeCoreDeps();
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      // A whitespace id — Express decodes "%20" so the handler sees a blank id.
      const res = await fetch(`${baseUrl}/api/workflows/%20/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
      expect(coreDeps.deploy).not.toHaveBeenCalled();
    });

    it("returns 404 when the workflow id is not registered", async () => {
      const coreDeps = makeCoreDeps();
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => null,
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/unknown/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("workflow not found");
      expect(coreDeps.deploy).not.toHaveBeenCalled();
    });

    it("links-on-deploy when the workflow has no definitionId in sapiom.json", async () => {
      // An unlinked workflow (no definitionId) must link via link({ create: true }),
      // write the resolved id to sapiom.json, then deploy — no 409.
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockReturnValue({}), // no definitionId
        link: vi.fn().mockResolvedValue({ definitionId: "def_new", name: "test-agent" }),
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_new",
          buildRunId: "build_1",
          status: "ready",
        }),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent", definitionSlug: "test-agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const events = parseNdjson(await res.text());
      expect(events).toEqual([
        { phase: "building", definitionId: "def_new" },
        { phase: "ready", definitionId: "def_new", buildRunId: "build_1", status: "ready" },
      ]);

      // link was called with create: true and the registry slug.
      expect(coreDeps.link).toHaveBeenCalledWith(
        { name: "test-agent", create: true },
        expect.anything(),
      );
      // writeConfig persisted the resolved id.
      expect(coreDeps.writeConfig).toHaveBeenCalledWith("/proj/agent", {
        definitionId: "def_new",
        name: "test-agent",
      });
      // deploy targeted the resolved id.
      expect(coreDeps.deploy).toHaveBeenCalledWith(
        { projectDir: "/proj/agent", definitionId: "def_new" },
        expect.anything(),
      );
    });

    it("resolves stale/foreign definitionId via link and redeploys to own definition", async () => {
      // sapiom.json carries a stale/foreign id (e.g. from a cloned template).
      // link() resolves by name (account-scoped) and returns the user's own id.
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockReturnValue({ definitionId: "def_foreign_267" }),
        link: vi.fn().mockResolvedValue({ definitionId: "def_mine_42", name: "my-agent" }),
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_mine_42",
          buildRunId: "build_7",
          status: "ready",
        }),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent", definitionSlug: "my-agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const events = parseNdjson(await res.text());
      // The resolved (own) id is the one used everywhere.
      expect(events).toEqual([
        { phase: "building", definitionId: "def_mine_42" },
        { phase: "ready", definitionId: "def_mine_42", buildRunId: "build_7", status: "ready" },
      ]);

      // link was called with the registry slug.
      expect(coreDeps.link).toHaveBeenCalledWith(
        { name: "my-agent", create: true },
        expect.anything(),
      );
      // writeConfig rewrote the stale id with the resolved one.
      expect(coreDeps.writeConfig).toHaveBeenCalledWith("/proj/agent", {
        definitionId: "def_mine_42",
        name: "my-agent",
      });
      // deploy targeted the user's own definition, not the foreign one.
      expect(coreDeps.deploy).toHaveBeenCalledWith(
        { projectDir: "/proj/agent", definitionId: "def_mine_42" },
        expect.anything(),
      );
    });

    it("skips writeConfig when link returns the same id already in sapiom.json", async () => {
      // id is already correct — no redundant write.
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockReturnValue({ definitionId: "def_123" }),
        link: vi.fn().mockResolvedValue({ definitionId: "def_123", name: "test-agent" }),
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_123",
          buildRunId: "build_9",
          status: "ready",
        }),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent", definitionSlug: "test-agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const events = parseNdjson(await res.text());
      expect(events.at(-1)).toMatchObject({ phase: "ready" });

      expect(coreDeps.writeConfig).not.toHaveBeenCalled();
    });

    it("falls back to check() for agent name when definitionSlug is absent", async () => {
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockReturnValue({}),
        check: vi.fn().mockResolvedValue({ name: "bundled-name", stepCount: 2, warnings: [], manifest: {} }),
        link: vi.fn().mockResolvedValue({ definitionId: "def_99", name: "bundled-name" }),
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_99",
          buildRunId: "build_3",
          status: "ready",
        }),
      });
      start({
        apiKey: "sk-test-key",
        // No definitionSlug supplied — forces check() path.
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const events = parseNdjson(await res.text());
      expect(events.at(-1)).toMatchObject({ phase: "ready" });

      // check was called to read the manifest name.
      expect(coreDeps.check).toHaveBeenCalledWith({
        sourceDir: "/proj/agent",
        typecheck: false,
      });
      // link received the bundled name.
      expect(coreDeps.link).toHaveBeenCalledWith(
        { name: "bundled-name", create: true },
        expect.anything(),
      );
    });

    it("falls back to directory basename when check() fails", async () => {
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockReturnValue({}),
        check: vi.fn().mockRejectedValue(new Error("bundle failed")),
        link: vi.fn().mockResolvedValue({ definitionId: "def_77", name: "my-project" }),
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_77",
          buildRunId: "build_5",
          status: "ready",
        }),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/my-project" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const events = parseNdjson(await res.text());
      expect(events.at(-1)).toMatchObject({ phase: "ready" });

      // link received the directory basename.
      expect(coreDeps.link).toHaveBeenCalledWith(
        { name: "my-project", create: true },
        expect.anything(),
      );
    });

    it("streams a terminal error when link() fails (no name in manifest)", async () => {
      const { AgentOperationError } = await import("@sapiom/agent-core");
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockReturnValue({}),
        // check returns an empty name and link is never reached.
        check: vi.fn().mockResolvedValue({ name: "", stepCount: 0, warnings: [], manifest: {} }),
        link: vi.fn().mockRejectedValue(
          new AgentOperationError({
            code: "HTTP_401",
            message: "Unauthorized.",
          }),
        ),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/basename-fallback" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const events = parseNdjson(await res.text());
      // Terminal error line — the link failure is surfaced in-band, no building phase.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ phase: "error", code: "HTTP_401" });
      expect(coreDeps.deploy).not.toHaveBeenCalled();
    });

    it("returns 503 (no network) when the harness has no API key", async () => {
      const coreDeps = makeCoreDeps();
      start({
        apiKey: null,
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("harness is not signed in to Sapiom");
      expect(coreDeps.deploy).not.toHaveBeenCalled();
      expect(coreDeps.createClient).not.toHaveBeenCalled();
    });

    it("authenticates via the provider's held key (not a boot snapshot)", async () => {
      // A provider (what the real server passes), not a plain string — the
      // client must be minted from provider.getKey(), and no refresh happens on
      // the happy path.
      const provider = refreshingProvider("sk-held-key", "sk-unused");
      const coreDeps = makeCoreDeps({
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_123",
          buildRunId: "build_9",
          status: "ready",
        }),
      });
      start({
        apiKey: provider,
        coreBaseUrl: "https://api.test",
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const events = parseNdjson(await res.text());
      expect(events.at(-1)).toMatchObject({ phase: "ready" });

      expect(coreDeps.createClient).toHaveBeenCalledWith({
        host: "https://api.test",
        apiKey: "sk-held-key",
      });
      expect(provider.refreshCalls).toBe(0);
    });

    it("returns 503 when the provider's held key is null", async () => {
      // A provider whose getKey() is null must behave exactly like apiKey: null.
      const coreDeps = makeCoreDeps();
      start({
        apiKey: refreshingProvider(null, null),
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(503);
      expect(coreDeps.deploy).not.toHaveBeenCalled();
      expect(coreDeps.createClient).not.toHaveBeenCalled();
    });

    it("recovers a 401 by refreshing the key and retrying, streaming ready", async () => {
      // First deploy attempt is rejected (stale key); the router refreshes to a
      // newer key and the retry succeeds — a single building line, then ready.
      // Note: link runs first (succeeds on first try with sk-stale); deploy then
      // fails 401 and retries with sk-fresh.
      const provider = refreshingProvider("sk-stale", "sk-fresh");
      const deploy = vi
        .fn()
        .mockRejectedValueOnce(await makeAuthRejection(401))
        .mockResolvedValueOnce({
          definitionId: "def_123",
          buildRunId: "build_9",
          status: "ready",
        });
      const coreDeps = makeCoreDeps({ deploy });
      start({
        apiKey: provider,
        coreBaseUrl: "https://api.test",
        resolveWorkflow: () => ({ path: "/proj/agent", definitionSlug: "test-agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const events = parseNdjson(await res.text());
      expect(events).toEqual([
        { phase: "building", definitionId: "def_123" },
        {
          phase: "ready",
          definitionId: "def_123",
          buildRunId: "build_9",
          status: "ready",
        },
      ]);

      expect(provider.refreshCalls).toBe(1);
      expect(deploy).toHaveBeenCalledTimes(2);
      // The deploy retry re-minted the client with the refreshed key.
      // createClient is called once for link (sk-stale), once for the first
      // deploy (sk-stale), and once for the deploy retry (sk-fresh).
      expect(coreDeps.createClient).toHaveBeenCalledWith({
        host: "https://api.test",
        apiKey: "sk-fresh",
      });
    });

    it("does not retry (streams the terminal 401) when refresh yields no newer key", async () => {
      // Every deploy attempt 401s and refresh returns the SAME key — the router
      // must refresh once, decline to retry, and stream the terminal error.
      const provider = refreshingProvider("sk-stale", "sk-stale");
      const deploy = vi.fn().mockRejectedValue(await makeAuthRejection(401));
      const coreDeps = makeCoreDeps({ deploy });
      start({
        apiKey: provider,
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const events = parseNdjson(await res.text());
      expect(events[0]).toEqual({ phase: "building", definitionId: "def_123" });
      // The hint is forwarded (safe — git credentials are redacted at source
      // before reaching the hint field, so no token reaches the browser).
      expect(events[1]).toMatchObject({ phase: "error", code: "HTTP_401", hint: "check your key" });
      // deploy was tried once; refresh ran but produced no different key so the
      // router did not burn a second attempt.
      expect(deploy).toHaveBeenCalledTimes(1);
      expect(provider.refreshCalls).toBe(1);
    });
  });

  // ── POST /api/runs ────────────────────────────────────────────────────────

  describe("POST /api/runs", () => {
    it("returns { executionId } on a successful prod run", async () => {
      const coreDeps = makeCoreDeps({
        run: vi.fn().mockResolvedValue({
          executionId: "exec_42",
          raw: { executionId: "exec_42" },
        }),
      });
      start({
        apiKey: "sk-test-key",
        coreBaseUrl: "https://api.test",
        resolveWorkflow: () => null,
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          definitionId: "def_123",
          input: { foo: "bar" },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ executionId: "exec_42" });

      expect(coreDeps.run).toHaveBeenCalledWith(
        { definitionId: "def_123", input: { foo: "bar" } },
        expect.anything(),
      );
      expect(coreDeps.createClient).toHaveBeenCalledWith({
        host: "https://api.test",
        apiKey: "sk-test-key",
      });
    });

    it("forwards an undefined input as-is (agent-core defaults it)", async () => {
      const coreDeps = makeCoreDeps({
        run: vi.fn().mockResolvedValue({ executionId: "exec_1", raw: {} }),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => null,
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "def_123" }),
      });
      expect(res.status).toBe(200);
      expect(coreDeps.run).toHaveBeenCalledWith(
        { definitionId: "def_123", input: undefined },
        expect.anything(),
      );
    });

    it("returns 400 when definitionId is missing", async () => {
      const coreDeps = makeCoreDeps();
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => null,
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("definitionId is required");
      expect(coreDeps.run).not.toHaveBeenCalled();
    });

    it("maps a gateway AgentOperationError to 502 with its code", async () => {
      const { AgentOperationError } = await import("@sapiom/agent-core");
      const coreDeps = makeCoreDeps({
        run: vi.fn().mockRejectedValue(
          new AgentOperationError({
            code: "HTTP_404",
            message: "Definition not found.",
            hint: "check your key",
          }),
        ),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => null,
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "def_missing" }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("Definition not found.");
      expect(body.code).toBe("HTTP_404");
      // The credential hint must NOT leak to the browser.
      expect(body.hint).toBeUndefined();
    });

    it("returns 503 when the harness has no API key", async () => {
      const coreDeps = makeCoreDeps();
      start({
        apiKey: null,
        resolveWorkflow: () => null,
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "def_123" }),
      });
      expect(res.status).toBe(503);
      expect(coreDeps.run).not.toHaveBeenCalled();
      expect(coreDeps.createClient).not.toHaveBeenCalled();
    });

    it("authenticates via the provider's held key (not a boot snapshot)", async () => {
      const provider = refreshingProvider("sk-held-key", "sk-unused");
      const coreDeps = makeCoreDeps({
        run: vi.fn().mockResolvedValue({ executionId: "exec_1", raw: {} }),
      });
      start({
        apiKey: provider,
        coreBaseUrl: "https://api.test",
        resolveWorkflow: () => null,
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "def_123" }),
      });
      expect(res.status).toBe(200);
      expect(coreDeps.createClient).toHaveBeenCalledWith({
        host: "https://api.test",
        apiKey: "sk-held-key",
      });
      expect(provider.refreshCalls).toBe(0);
    });

    it("returns 503 when the provider's held key is null", async () => {
      const coreDeps = makeCoreDeps();
      start({
        apiKey: refreshingProvider(null, null),
        resolveWorkflow: () => null,
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "def_123" }),
      });
      expect(res.status).toBe(503);
      expect(coreDeps.run).not.toHaveBeenCalled();
      expect(coreDeps.createClient).not.toHaveBeenCalled();
    });

    it("recovers a 401 by refreshing the key and retrying, returning executionId", async () => {
      const provider = refreshingProvider("sk-stale", "sk-fresh");
      const run = vi
        .fn()
        .mockRejectedValueOnce(await makeAuthRejection(401))
        .mockResolvedValueOnce({ executionId: "exec_42", raw: {} });
      const coreDeps = makeCoreDeps({ run });
      start({
        apiKey: provider,
        coreBaseUrl: "https://api.test",
        resolveWorkflow: () => null,
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "def_123", input: { foo: "bar" } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ executionId: "exec_42" });

      expect(provider.refreshCalls).toBe(1);
      expect(run).toHaveBeenCalledTimes(2);
      // The retried run reused the same request args, minted against the new key.
      expect(run).toHaveBeenNthCalledWith(
        2,
        { definitionId: "def_123", input: { foo: "bar" } },
        expect.anything(),
      );
      expect(coreDeps.createClient).toHaveBeenNthCalledWith(1, {
        host: "https://api.test",
        apiKey: "sk-stale",
      });
      expect(coreDeps.createClient).toHaveBeenNthCalledWith(2, {
        host: "https://api.test",
        apiKey: "sk-fresh",
      });
    });

    it("also refreshes + retries on a 403 (authorization loss)", async () => {
      const provider = refreshingProvider("sk-stale", "sk-fresh");
      const run = vi
        .fn()
        .mockRejectedValueOnce(await makeAuthRejection(403))
        .mockResolvedValueOnce({ executionId: "exec_7", raw: {} });
      const coreDeps = makeCoreDeps({ run });
      start({ apiKey: provider, resolveWorkflow: () => null, coreDeps });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "def_123" }),
      });
      expect(res.status).toBe(200);
      expect(provider.refreshCalls).toBe(1);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("maps a 401 to 502 (no retry, hint stripped) when refresh yields no newer key", async () => {
      // The auth error is unrecoverable — refresh returns the same key. The
      // router must not retry, and the credential hint must not reach the browser.
      const provider = refreshingProvider("sk-stale", "sk-stale");
      const run = vi.fn().mockRejectedValue(await makeAuthRejection(401));
      const coreDeps = makeCoreDeps({ run });
      start({ apiKey: provider, resolveWorkflow: () => null, coreDeps });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "def_123" }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("HTTP_401");
      expect(body.hint).toBeUndefined();
      expect(run).toHaveBeenCalledTimes(1);
      expect(provider.refreshCalls).toBe(1);
    });

    it("does not refresh on a non-auth gateway error", async () => {
      // A 404 (definition not found) is not an auth rejection — no refresh, no
      // retry, mapped straight to 502.
      const { AgentOperationError } = await import("@sapiom/agent-core");
      const provider = refreshingProvider("sk-key", "sk-unused");
      const run = vi.fn().mockRejectedValue(
        new AgentOperationError({
          code: "HTTP_404",
          message: "Definition not found.",
        }),
      );
      const coreDeps = makeCoreDeps({ run });
      start({ apiKey: provider, resolveWorkflow: () => null, coreDeps });

      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "def_missing" }),
      });
      expect(res.status).toBe(502);
      expect(run).toHaveBeenCalledTimes(1);
      expect(provider.refreshCalls).toBe(0);
    });
  });

  // ── POST /api/runs/local ──────────────────────────────────────────────────

  describe("POST /api/runs/local", () => {
    it("streams per-step NDJSON then the terminal summary, forwarded verbatim", async () => {
      const { child, spawn, whenSpawned } = spawnFake();
      start({
        apiKey: null, // run-local needs no key — works signed out.
        resolveWorkflow: () => null,
        runLocalSpawn: spawn,
      });

      const resPromise = fetch(`${baseUrl}/api/runs/local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceDir: "/proj/agent", input: { name: "x" } }),
      });

      // Drive the scripted child once the route has wired its listeners.
      await whenSpawned;
      child.emitLine({
        step: "greet",
        attempt: 0,
        input: { name: "x" },
        status: "succeeded",
        output: { greeting: "hi" },
        logs: [],
      });
      child.emitLine({
        kind: "summary",
        outcome: "completed",
        output: { greeting: "hi" },
        unusedStubs: [{ step: "greet", key: "web.search" }],
        stubWarnings: [],
      });
      child.finish(0);

      const res = await resPromise;
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");

      const lines = parseNdjson(await res.text());
      expect(lines[0]).toMatchObject({ step: "greet", status: "succeeded" });
      expect(lines[1]).toEqual({
        kind: "summary",
        outcome: "completed",
        output: { greeting: "hi" },
        unusedStubs: [{ step: "greet", key: "web.search" }],
        stubWarnings: [],
      });

      // The request was piped to the child's stdin as one JSON object.
      expect(JSON.parse(child.stdinChunks.join(""))).toEqual({
        sourceDir: "/proj/agent",
        input: { name: "x" },
        maxAttemptsPerStep: undefined,
      });
    });

    it("surfaces unusedStubs/stubWarnings on the terminal line", async () => {
      const { child, spawn, whenSpawned } = spawnFake();
      start({ apiKey: null, resolveWorkflow: () => null, runLocalSpawn: spawn });

      const resPromise = fetch(`${baseUrl}/api/runs/local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceDir: "/proj/agent" }),
      });

      await whenSpawned;
      child.emitLine({
        kind: "summary",
        outcome: "failed",
        unusedStubs: [{ step: "s", key: "models.coding.launch" }],
        stubWarnings: ["s: web.search stub had the wrong shape"],
      });
      child.finish(0);

      const lines = parseNdjson(await (await resPromise).text());
      expect(lines[0]).toMatchObject({
        outcome: "failed",
        unusedStubs: [{ step: "s", key: "models.coding.launch" }],
        stubWarnings: ["s: web.search stub had the wrong shape"],
      });
    });

    it("forwards a summary still buffered when the process exit fires first", async () => {
      // The race the route hardens against: `exit` can arrive before readline
      // has drained the last stdout chunk. Emitting the summary and firing exit
      // synchronously (without FakeChild.finish's setImmediate) reproduces it —
      // the summary must still be forwarded, with no synthesized error appended.
      const { child, spawn, whenSpawned } = spawnFake();
      start({ apiKey: null, resolveWorkflow: () => null, runLocalSpawn: spawn });

      const resPromise = fetch(`${baseUrl}/api/runs/local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceDir: "/proj/agent" }),
      });

      await whenSpawned;
      child.emitLine({
        kind: "summary",
        outcome: "completed",
        unusedStubs: [],
        stubWarnings: [],
      });
      child.emit("exit", 0); // exit BEFORE stdout is closed/drained
      child.stdout.end(); // readline "close" now fires → settle()
      child.stderr.end();

      const lines = parseNdjson(await (await resPromise).text());
      // Exactly the one real summary — no trailing synthesized error line.
      expect(lines).toEqual([
        { kind: "summary", outcome: "completed", unusedStubs: [], stubWarnings: [] },
      ]);
    });

    it("returns 400 when sourceDir is missing (no child spawned)", async () => {
      const spawn = vi.fn(() => new FakeChild());
      start({ apiKey: null, resolveWorkflow: () => null, runLocalSpawn: spawn });

      const res = await fetch(`${baseUrl}/api/runs/local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("sourceDir is required");
      expect(spawn).not.toHaveBeenCalled();
    });

    it("ignores non-JSON noise on stdout (forwards only well-formed lines)", async () => {
      const { child, spawn, whenSpawned } = spawnFake();
      start({ apiKey: null, resolveWorkflow: () => null, runLocalSpawn: spawn });

      const resPromise = fetch(`${baseUrl}/api/runs/local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceDir: "/proj/agent" }),
      });

      await whenSpawned;
      child.emitRaw("some esbuild warning to stdout\n"); // noise — dropped
      child.emitLine({ kind: "summary", outcome: "completed", unusedStubs: [], stubWarnings: [] });
      child.finish(0);

      const lines = parseNdjson(await (await resPromise).text());
      // parseNdjson JSON.parses every non-blank line, so a forwarded noise line
      // would throw here — asserting exactly one (the summary) proves the route
      // dropped the non-JSON line.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ kind: "summary", outcome: "completed" });
    });

    it("synthesizes a terminal error line when the child crashes before emitting one", async () => {
      const { child, spawn, whenSpawned } = spawnFake();
      start({ apiKey: null, resolveWorkflow: () => null, runLocalSpawn: spawn });

      const resPromise = fetch(`${baseUrl}/api/runs/local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceDir: "/proj/agent" }),
      });

      await whenSpawned;
      child.stderr.write("Failed to bundle the agent.\n");
      child.finish(1); // nonzero exit, no terminal line was written

      const lines = parseNdjson(await (await resPromise).text());
      expect(lines).toEqual([
        {
          kind: "error",
          outcome: "failed",
          error: "Failed to bundle the agent.",
        },
      ]);
    });

    it("does not double-report when both error and exit fire", async () => {
      const { child, spawn, whenSpawned } = spawnFake();
      start({ apiKey: null, resolveWorkflow: () => null, runLocalSpawn: spawn });

      const resPromise = fetch(`${baseUrl}/api/runs/local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceDir: "/proj/agent" }),
      });

      await whenSpawned; // the route's error+exit listeners are now attached.
      child.stdout.end();
      child.stderr.end();
      child.emit("error", new Error("spawn ENOENT"));
      child.emit("exit", null);

      const lines = parseNdjson(await (await resPromise).text());
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ kind: "error", outcome: "failed" });
    });

    it("answers in-band with a terminal error line when the spawn itself throws", async () => {
      start({
        apiKey: null,
        resolveWorkflow: () => null,
        runLocalSpawn: () => {
          throw new Error("node binary not found");
        },
      });

      const res = await fetch(`${baseUrl}/api/runs/local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceDir: "/proj/agent" }),
      });
      // The request itself is valid, so it's a 200 NDJSON stream whose single
      // line is the terminal error.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const lines = parseNdjson(await res.text());
      expect(lines).toEqual([
        {
          kind: "error",
          outcome: "failed",
          error: "node binary not found",
        },
      ]);
    });
  });

  // ── bootstrap path resolution (pure) ──────────────────────────────────────

  describe("resolveRunLocalBootstrapPath", () => {
    it("resolves the built .js sibling from a dist actions module URL", () => {
      const p = resolveRunLocalBootstrapPath(
        "file:///app/packages/harness/dist/server/actions.js",
      );
      expect(p).toBe(
        "/app/packages/harness/dist/core/run-local-bootstrap.js",
      );
    });

    it("resolves the .ts sibling from a src actions module URL (dev/tsx)", () => {
      const p = resolveRunLocalBootstrapPath(
        "file:///app/packages/harness/src/server/actions.ts",
      );
      expect(p).toBe("/app/packages/harness/src/core/run-local-bootstrap.ts");
    });
  });
});
