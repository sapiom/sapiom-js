import {
  agentManifestSchema,
  buildManifest,
  defineAgent,
  defineStep,
  isPauseTimeout,
  pauseUntilSignal,
  terminate,
  type AgentDefinition,
  type AgentManifest,
} from "@sapiom/agent";
import {
  ADVANCE_RESULT_KIND,
  AgentRunnerCore,
  EXECUTION_STATUS,
  InMemoryExecutionStore,
  NOOP_OBSERVER,
} from "@sapiom/agent-runtime";

import { LocalStubDispatcher } from "./dispatcher.js";

function manifestFor(def: AgentDefinition): AgentManifest {
  return agentManifestSchema.parse(
    buildManifest(def, {
      sdkVersion: "0.0.0-test",
      artifact: { sha256: "x", entryFile: "def.mjs" },
    }),
  ) as AgentManifest;
}

describe("LocalStubDispatcher — pause timeoutStep", () => {
  // The dispatched path: the step body's pause directive goes through
  // splitDirective into the completion payload, and the runner persists the pause
  // from that payload. A timeoutStep dropped on the way means the deadline fails
  // the run instead of taking the declared branch.
  it("carries timeoutStep from the authored pause to the timeout branch", async () => {
    let escalated: unknown;
    const wait = defineStep({
      name: "wait",
      next: [],
      pause: {
        signal: "vendor.confirmed",
        resumeStep: "ship",
        timeoutStep: "escalate",
      },
      async run() {
        return pauseUntilSignal({
          signal: "vendor.confirmed",
          resumeStep: "ship",
          timeoutMs: 1,
          timeoutStep: "escalate",
        });
      },
    });
    const ship = defineStep({
      name: "ship",
      next: [],
      terminal: true,
      async run() {
        return terminate({ shipped: true });
      },
    });
    const escalate = defineStep({
      name: "escalate",
      next: [],
      terminal: true,
      async run(input) {
        escalated = input;
        return terminate({ escalated: true });
      },
    });
    const def = defineAgent({
      name: "timeout-branch",
      entry: "wait",
      steps: { wait, ship, escalate },
    });

    const store = new InMemoryExecutionStore();
    const dispatcher = new LocalStubDispatcher(def, { version: 1, steps: {} });
    const core = new AgentRunnerCore({
      store,
      dispatcher,
      observer: NOOP_OBSERVER,
    });
    dispatcher.setCore(core);

    const executionId = await core.createExecution(
      def.name,
      def.entry,
      {},
      { manifest: manifestFor(def) },
    );
    await core.advance(executionId);
    const paused = store.getExecution(executionId);
    expect(paused?.status).toBe(EXECUTION_STATUS.PAUSED);
    expect(paused?.pausedTimeoutStep).toBe("escalate");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = await core.expirePausedExecution(executionId);
    expect(expired?.kind).toBe(ADVANCE_RESULT_KIND.RUNNING);
    expect(store.getExecution(executionId)?.currentStep).toBe("escalate");

    await core.advance(executionId);
    expect(store.getExecution(executionId)?.status).toBe(
      EXECUTION_STATUS.COMPLETED,
    );
    expect(isPauseTimeout(escalated)).toBe(true);
  });
});
