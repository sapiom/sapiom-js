/**
 * Test fixture — a workflow authored against the PRE-RENAME SDK
 * (`@sapiom/orchestration`, before commit cc1261e renamed everything to
 * agents/models). The `defineOrchestration`/`defineStep` stubs below are a
 * faithful, self-contained copy of that package's runtime (same brand symbol,
 * same step-shape normalization), so this fixture exercises the legacy-brand
 * detection path in `@sapiom/agent-core`'s `check()` without depending on a
 * package that is no longer in this repo. What matters to the extractor:
 *   - the definition is branded `Symbol.for('sapiom.orchestration.definition')`,
 *     NOT the current `sapiom.models.definition`;
 *   - steps carry the identical runtime properties buildManifest reads
 *     (name/next/terminal/canFail/pause), proving the old shape needs no shim.
 */

const ORCHESTRATION_DEFINITION_BRAND = Symbol.for("sapiom.orchestration.definition");

interface LegacyStepDefinition {
  name: string;
  next?: string[];
  terminal?: boolean;
  canFail?: boolean;
  pause?: { signal: string; resumeStep: string };
  run: (input: unknown) => Promise<unknown>;
}

// Mirrors @sapiom/orchestration's defineStep: normalizes declared routing
// capabilities into always-present runtime properties.
function defineStep(def: LegacyStepDefinition) {
  return {
    name: def.name,
    next: def.next ?? [],
    terminal: def.terminal ?? false,
    canFail: def.canFail ?? false,
    ...(def.pause ? { pause: def.pause } : {}),
    run: def.run,
  };
}

// Mirrors @sapiom/orchestration's defineOrchestration: attaches the legacy
// brand as a non-enumerable property, exactly like the real package did.
function defineOrchestration(def: { name: string; entry: string; steps: Record<string, unknown> }) {
  Object.defineProperty(def, ORCHESTRATION_DEFINITION_BRAND, {
    value: 1,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return def;
}

const receive = defineStep({
  name: "receive",
  next: ["confirm"],
  async run(input) {
    return { kind: "continue", stepName: "confirm", output: input };
  },
});

const confirm = defineStep({
  name: "confirm",
  next: ["award"],
  pause: { signal: "vendor.confirm", resumeStep: "award" },
  async run(input) {
    return { kind: "pause_until_signal", signal: "vendor.confirm", output: input };
  },
});

const award = defineStep({
  name: "award",
  terminal: true,
  canFail: true,
  async run(input) {
    return { kind: "terminate", output: input };
  },
});

export const workflow = defineOrchestration({
  name: "legacy-flow",
  entry: "receive",
  steps: { receive, confirm, award },
});
