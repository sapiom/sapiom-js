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

    it("returns 409 when the workflow has no linked definitionId", async () => {
      const coreDeps = makeCoreDeps({
        // sapiom.json present but not linked (no definitionId).
        readConfig: vi.fn().mockReturnValue({}),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("workflow is not linked to a Sapiom agent");
      expect(coreDeps.deploy).not.toHaveBeenCalled();
    });

    it("returns 409 when sapiom.json is unreadable/unparseable", async () => {
      const { AgentOperationError } = await import("@sapiom/agent-core");
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockImplementation(() => {
          throw new AgentOperationError({
            code: "BAD_CONFIG",
            message: "sapiom.json is not valid JSON.",
          });
        }),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
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
