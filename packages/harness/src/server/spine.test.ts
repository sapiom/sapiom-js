import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSpineRouter, type SpineRouterOpts } from "./spine.js";
import type { SpineClient } from "../core/spine-client.js";
import type { BusMessage } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A fake spine client that drives a fixed sequence of handler callbacks
 * synchronously — so by the time run() resolves, every frame it was going to
 * publish already has. Lets the route be tested with no real network or poll
 * loop.
 */
function fakeClient(
  script: (h: Parameters<SpineClient["run"]>[2]) => void,
): { createClient: SpineRouterOpts["createClient"]; lastDef: () => string } {
  let lastDef = "";
  const createClient: SpineRouterOpts["createClient"] = () => ({
    async run(definitionId, _input, handlers = {}) {
      lastDef = definitionId;
      script(handlers);
      return { ok: true, executionId: "exec_1", status: "completed" };
    },
  });
  return { createClient, lastDef: () => lastDef };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSpineRouter", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;
  let published: BusMessage[];

  function start(opts: Partial<SpineRouterOpts>): void {
    published = [];
    const app = express();
    app.use(express.json());
    app.use(
      createSpineRouter({
        apiKey: "sk-test",
        bus: { publish: (m) => published.push(m) },
        definitionId: "def-hardcoded",
        generateRunId: () => "run-1",
        ...opts,
      }),
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("accepts a run and streams spine.* frames onto the bus", async () => {
    const { createClient, lastDef } = fakeClient((h) => {
      h?.onStarted?.("exec_1");
      h?.onFrame?.({ step: { id: "s1", name: "explain", status: "running" } });
      h?.onFrame?.({
        step: { id: "s1", name: "explain", status: "passed", latencyMs: 900 },
      });
      h?.onFinished?.("exec_1", "completed");
    });
    start({ createClient });

    const res = await fetch(`${baseUrl}/api/spine/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      spineRunId: "run-1",
      definitionId: "def-hardcoded",
    });
    // Defaulted to the hardcoded definition id when the body omitted one.
    expect(lastDef()).toBe("def-hardcoded");

    expect(published).toEqual([
      { type: "spine.started", spineRunId: "run-1", executionId: "exec_1" },
      {
        type: "spine.frame",
        spineRunId: "run-1",
        executionId: "exec_1",
        frame: { step: { id: "s1", name: "explain", status: "running" } },
      },
      {
        type: "spine.frame",
        spineRunId: "run-1",
        executionId: "exec_1",
        frame: {
          step: { id: "s1", name: "explain", status: "passed", latencyMs: 900 },
        },
      },
      {
        type: "spine.finished",
        spineRunId: "run-1",
        executionId: "exec_1",
        status: "completed",
      },
    ]);
  });

  it("honors a definitionId override in the body", async () => {
    const { createClient, lastDef } = fakeClient((h) => h?.onStarted?.("e"));
    start({ createClient });

    const res = await fetch(`${baseUrl}/api/spine/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "def-override", input: { a: 1 } }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.definitionId).toBe("def-override");
    expect(lastDef()).toBe("def-override");
  });

  it("publishes spine.error when the run errors", async () => {
    const createClient: SpineRouterOpts["createClient"] = () => ({
      async run(_d, _i, handlers = {}) {
        handlers.onError?.("gateway responded 500");
        return { ok: false, status: 502, error: "gateway responded 500" };
      },
    });
    start({ createClient });

    await fetch(`${baseUrl}/api/spine/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(published).toEqual([
      {
        type: "spine.error",
        spineRunId: "run-1",
        error: "gateway responded 500",
      },
    ]);
  });

  it("returns 503 and does not construct a client without an API key", async () => {
    const createClient = vi.fn();
    start({ apiKey: null, createClient });

    const res = await fetch(`${baseUrl}/api/spine/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("harness is not signed in to Sapiom");
    expect(createClient).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("rejects a malformed input body with 400", async () => {
    const createClient = vi.fn();
    start({ createClient });

    const res = await fetch(`${baseUrl}/api/spine/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "not-an-object" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("input must be an object");
    expect(createClient).not.toHaveBeenCalled();
  });
});
