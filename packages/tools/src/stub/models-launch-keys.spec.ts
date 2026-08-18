import { createStubClient } from "./index.js";

// `models.launch` resolved `dispatchedKeys("agent")` — a spelling stranded by the agent→models
// half of the #167 rename — while its own comment and the sibling `models.run` promise
// `models.*` keys. So a `models.run` / `models.launch` override was silently ignored by
// `launch()` and only the stale `agent.*` keys applied. The launch path now consults
// `models.launch` > `models.run` > legacy `agent.launch` > `agent.run` (legacy kept for
// back-compat, with a warning), and merges the override OVER the built-in defaults so the
// handle and the schema-validated resume payload always carry a full ModelRunResult.
describe("createStubClient().models — launch override keys", () => {
  it("honors a models.run override on launch() (the documented shared key)", async () => {
    const stub = createStubClient({
      overrides: {
        "models.run": { status: "completed", output: "from-models-run" },
      },
    });

    const handle = await stub.models.launch({ prompt: "x" });

    expect((await handle.wait()).output).toBe("from-models-run");
  });

  it("pins the full precedence order: models.launch > models.run > agent.launch > agent.run", async () => {
    const overrides = {
      "models.launch": { status: "completed", output: "from-models-launch" },
      "models.run": { status: "completed", output: "from-models-run" },
      "agent.launch": { status: "completed", output: "from-agent-launch" },
      "agent.run": { status: "completed", output: "from-agent-run" },
    };
    // Peel one layer off per client: each time the highest-precedence key is removed,
    // the next one in the documented order must win.
    const order = [
      ["models.launch", "from-models-launch"],
      ["models.run", "from-models-run"],
      ["agent.launch", "from-agent-launch"],
      ["agent.run", "from-agent-run"],
    ] as const;

    const remaining: Record<string, unknown> = { ...overrides };
    for (const [key, expected] of order) {
      const stub = createStubClient({ overrides: { ...remaining } });
      const handle = await stub.models.launch({ prompt: "x" });
      expect((await handle.wait()).output).toBe(expected);
      delete remaining[key];
    }
  });

  it("matching a legacy agent.* key emits a warning naming the documented spelling", async () => {
    const warnings = new Set<string>();
    const stub = createStubClient({
      overrides: {
        "agent.run": { status: "completed", output: "from-legacy" },
      },
      warnings,
    });

    const handle = await stub.models.launch({ prompt: "x" });

    expect((await handle.wait()).output).toBe("from-legacy");
    expect([...warnings].some((w) => w.includes("'agent.run'"))).toBe(true);
    expect([...warnings].some((w) => w.includes("models.run"))).toBe(true);
  });

  it("a PARTIAL models.run override is merged over the defaults (full shape for handle + resume)", async () => {
    // The documented minimal stub shape ({ output } only) must not truncate the result:
    // the handle reads result.status and the local runner schema-validates the resume payload.
    const signals = new Map<string, unknown>();
    const stub = createStubClient({
      overrides: { "models.run": { output: "SELECT 1" } },
      signals,
    });

    const handle = await stub.models.launch({ prompt: "x" });
    const result = await handle.wait();

    expect(result.output).toBe("SELECT 1");
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(await handle.status()).toBe("completed");
    // The resume payload a paused step receives carries the same merged shape.
    const payload = signals.get(handle.dispatch.correlationId) as {
      output: string;
      status: string;
    };
    expect(payload.output).toBe("SELECT 1");
    expect(payload.status).toBe("completed");
  });

  it("a function override returning a Promise is awaited (not spread as a thenable)", async () => {
    const stub = createStubClient({
      overrides: {
        "models.run": async () => ({
          status: "completed",
          output: "from-async-fn",
        }),
      },
    });

    const handle = await stub.models.launch({ prompt: "x" });

    expect((await handle.wait()).output).toBe("from-async-fn");
  });

  it("an author-supplied runId is preserved across launch(), wait(), and the resume correlation", async () => {
    // In the real client run() IS launch().wait(), so both paths must agree on the id.
    const signals = new Map<string, unknown>();
    const stub = createStubClient({
      overrides: {
        "models.run": { runId: "r1", status: "completed", output: "o" },
      },
      signals,
    });

    const handle = await stub.models.launch({ prompt: "x" });

    expect((await handle.wait()).runId).toBe("r1");
    expect(handle.dispatch.correlationId).toBe("r1");
    expect(signals.has("r1")).toBe(true);
  });

  it("run() resolves models.run only, verbatim (legacy keys don't leak into it)", async () => {
    const stub = createStubClient({
      overrides: {
        "models.run": { status: "completed", output: "from-models-run" },
        "agent.run": { status: "completed", output: "should-not-leak" },
      },
    });
    expect((await stub.models.run({ prompt: "x" })).output).toBe(
      "from-models-run",
    );

    const legacyOnly = createStubClient({
      overrides: {
        "agent.run": { status: "completed", output: "should-not-leak" },
      },
    });
    const out = await legacyOnly.models.run({ prompt: "x" });
    expect(out.output).not.toBe("should-not-leak");
    expect(out.status).toBe("completed");
  });
});
