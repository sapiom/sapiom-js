import { createStubClient } from "./index.js";

// `models.launch` resolved `dispatchedKeys("agent")` — a spelling left over from the
// orchestrations→agents rename (#167) — while its own comment and the sibling `models.run`
// promise `models.*` keys. So a `models.run` / `models.launch` override was silently ignored
// by `launch()` and only the stale `agent.*` keys applied. The launch path now consults
// `models.launch` > `models.run` > legacy `agent.launch` / `agent.run` (kept for back-compat:
// they were the only working keys before this fix, so existing stub files may use them).
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

  it("the models.launch key wins over models.run when both are supplied", async () => {
    const stub = createStubClient({
      overrides: {
        "models.launch": { status: "completed", output: "from-launch" },
        "models.run": { status: "completed", output: "from-run" },
      },
    });

    const handle = await stub.models.launch({ prompt: "x" });

    expect((await handle.wait()).output).toBe("from-launch");
  });

  it("legacy agent.* keys stay honored, but models.* wins when both are present", async () => {
    // A stub file written against the pre-fix behavior keeps working…
    const legacy = createStubClient({
      overrides: {
        "agent.run": { status: "completed", output: "from-legacy-agent-run" },
      },
    });
    const h1 = await legacy.models.launch({ prompt: "x" });
    expect((await h1.wait()).output).toBe("from-legacy-agent-run");

    // …and the documented spelling takes precedence over the legacy one.
    const both = createStubClient({
      overrides: {
        "models.run": { status: "completed", output: "from-models-run" },
        "agent.run": { status: "completed", output: "from-legacy-agent-run" },
      },
    });
    const h2 = await both.models.launch({ prompt: "x" });
    expect((await h2.wait()).output).toBe("from-models-run");
  });

  it("run() behavior is unchanged (resolves models.run only)", async () => {
    const stub = createStubClient({
      overrides: {
        "agent.run": { status: "completed", output: "from-legacy-agent-run" },
      },
    });

    // run() never consulted the legacy keys; the built-in default still applies.
    const out = await stub.models.run({ prompt: "x" });

    expect(out.output).toBe("(stub) agent run completed locally");
  });
});
