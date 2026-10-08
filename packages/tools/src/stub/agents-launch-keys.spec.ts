import { AgentDispatchError } from "../agents/index.js";
import { createStubClient } from "./index.js";

// `agents.launch` built its handle unconditionally as a success and never
// consulted the overrides, while its sibling `agents.run` (and
// `models.coding.launch`) both resolved through them. The README and the
// authoring skill tell every author to write
// try/catch around `launch`, so under the stub that catch block was dead code
// no local test could cover. `launch()` now consults `agents.launch` >
// `agents.run`, merged over the built-in defaults, and mirrors the real
// client's split: a stubbed `status: "rejected"` THROWS from `launch` and
// RESOLVES from `run`.
describe("createStubClient().agents — launch override keys", () => {
  it("defaults to a completed, pausable run when nothing is stubbed", async () => {
    const stub = createStubClient();

    const handle = await stub.agents.launch({ definition: "enrich-lead" });

    expect(handle.dispatch.resultSignal).toBe("agents.result");
    expect(await handle.status()).toBe("completed");
    expect(await handle.wait()).toMatchObject({
      status: "completed",
      output: {},
    });
  });

  it("honors an agents.run override on launch() (the shared key)", async () => {
    const stub = createStubClient({
      overrides: {
        "agents.run": { status: "failed", error: { message: "child blew up" } },
      },
    });

    const handle = await stub.agents.launch({ definition: "enrich-lead" });

    expect((await handle.wait()).status).toBe("failed");
  });

  it("pins the precedence order: agents.launch > agents.run", async () => {
    const stub = createStubClient({
      overrides: {
        "agents.launch": { status: "completed", output: "from-launch" },
        "agents.run": { status: "completed", output: "from-run" },
      },
    });

    const handle = await stub.agents.launch({ definition: "enrich-lead" });

    expect((await handle.wait()).output).toBe("from-launch");
  });

  it("lets a stubbed rejection exercise the try/catch the docs require", async () => {
    const rejection = {
      code: "not_found",
      message: "no such definition: typo-slug",
      status: 404,
      details: null,
    };
    const stub = createStubClient({
      overrides: { "agents.launch": { status: "rejected", error: rejection } },
    });

    // Throws exactly as the real client does, so the author's catch block runs
    // in a local test instead of being dead code until production.
    await expect(
      stub.agents.launch({ definition: "typo-slug" }),
    ).rejects.toMatchObject({
      name: "AgentDispatchError",
      code: "not_found",
      status: 404,
    });
  });

  it("keeps a stubbed rejection as DATA on the run() path", async () => {
    const stub = createStubClient({
      overrides: {
        "agents.run": {
          status: "rejected",
          error: {
            code: "not_found",
            message: "gone",
            status: 404,
            details: null,
          },
        },
      },
    });

    // Same override key family, opposite mechanism — mirroring the real client.
    const result = await stub.agents.run({ definition: "typo-slug" });

    expect(result).toMatchObject({ status: "rejected", executionId: null });
  });

  it("fills in a partial override, keeping executionId null only on a rejection", async () => {
    const rejected = createStubClient({
      overrides: { "agents.run": { status: "rejected" } },
    });
    // A partial stub still yields every field — the resume payload needs them —
    // and the public contract says a rejected result carries an AgentRunError,
    // so `result.error.code` must read the same way it does in production.
    expect(await rejected.agents.run({ definition: "typo-slug" })).toEqual({
      executionId: null,
      status: "rejected",
      output: null,
      error: {
        code: "transport",
        message: "stubbed dispatch rejection",
        status: null,
        details: null,
      },
    });

    const failed = createStubClient({
      overrides: { "agents.run": { status: "failed" } },
    });
    const result = await failed.agents.run({ definition: "enrich-lead" });
    // The run exists, so it is named even though it failed.
    expect(result.executionId).toMatch(/^stub-exec-/);
    expect(result.output).toBeNull();
  });

  it("registers a resume payload matching the stubbed status", async () => {
    const signals = new Map<string, unknown>();
    const stub = createStubClient({
      signals,
      overrides: {
        "agents.launch": { status: "failed", error: { message: "nope" } },
      },
    });

    const handle = await stub.agents.launch({ definition: "enrich-lead" });

    // A local pauseUntilSignal on this handle resumes with the `failed`
    // variant, so the resumed step's own branch is testable too.
    expect(signals.get(handle.executionId as string)).toMatchObject({
      status: "failed",
      definition: "enrich-lead",
      error: { message: "nope" },
    });
  });

  it("awaits an override function that returns a promise", async () => {
    const stub = createStubClient({
      overrides: {
        // Supported everywhere else in the stub, so it must work here: an
        // unawaited promise reads as `{}` and silently becomes "completed".
        "agents.run": async () => ({
          status: "failed",
          error: { message: "async stub" },
        }),
      },
    });

    const result = await stub.agents.run({ definition: "enrich-lead" });

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({ message: "async stub" });
  });

  it("mirrors production's delayed-dispatch handle for `at` (null id, trigger correlation)", async () => {
    const stub = createStubClient();

    const handle = await stub.agents.launch({
      definition: "enrich-lead",
      at: "2099-01-01T00:00:00.000Z",
    });

    // Production returns no executionId until the schedule fires and correlates
    // on the trigger, so a local run of a scheduled child must not see a run id.
    expect(handle.executionId).toBeNull();
    expect(handle.dispatch.correlationId).toMatch(/^trigger-/);
  });

  it("registers no resume payload for a rejected launch (nothing will ever fire)", async () => {
    const signals = new Map<string, unknown>();
    const stub = createStubClient({
      signals,
      overrides: { "agents.launch": { status: "rejected" } },
    });

    await expect(
      stub.agents.launch({ definition: "typo-slug" }),
    ).rejects.toBeInstanceOf(AgentDispatchError);

    expect(signals.size).toBe(0);
  });
});
