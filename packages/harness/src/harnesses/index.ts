/**
 * Harness adapter registry.
 *
 * One adapter file per harness plus one line in {@link HARNESS_ADAPTERS}
 * — that is the whole cost of supporting a new harness. `getAdapter` and
 * `listAdapters` read the default registry; `createHarnessRegistry`
 * builds custom registries from any adapter list (which is also how the
 * tests prove that registration is purely data-driven).
 */
import type { HarnessAdapter } from "./adapter.js";
import { createHarnessRegistry } from "./registry.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { piAdapter } from "./pi.js";
import { opencodeAdapter } from "./opencode.js";
import { conductorAdapter } from "./conductor.js";

/** Every built-in adapter, in presentation order. */
export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  piAdapter,
  opencodeAdapter,
  conductorAdapter,
];

const defaultRegistry = createHarnessRegistry(HARNESS_ADAPTERS);

/** All registered adapters, in registration order. */
export function listAdapters(): readonly HarnessAdapter[] {
  return defaultRegistry.list();
}

/**
 * The adapter with the given id. Accepts any string (ids often arrive
 * from config files or HTTP) and throws `UnknownHarnessError` when
 * nothing matches.
 */
export function getAdapter(id: string): HarnessAdapter {
  return defaultRegistry.get(id);
}

export type {
  EmbeddedHarnessAdapter,
  ExternalHarnessAdapter,
  HarnessAdapter,
  HarnessAdapterCommon,
  HarnessId,
  HarnessLaunch,
  HarnessLaunchConfig,
  HarnessMode,
  PromptDelivery,
} from "./adapter.js";
export { createHarnessRegistry, UnknownHarnessError } from "./registry.js";
export type { HarnessRegistry } from "./registry.js";
export { findExecutableOnPath, isExecutableOnPath } from "./detect.js";
export type { FindExecutableOptions } from "./detect.js";
export { claudeCodeAdapter } from "./claude-code.js";
export { codexAdapter } from "./codex.js";
export { piAdapter } from "./pi.js";
export { opencodeAdapter } from "./opencode.js";
export { conductorAdapter, conductorAppCandidates } from "./conductor.js";
