import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createActionsRouter, type ActionsRouterOpts } from "./actions.js";

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
});
