/**
 * HarnessAdapter registry: enumeration and id-based lookup over a fixed set
 * of adapter descriptors. Separate from SessionManager's adapter map
 * (Partial<Record<HarnessKind, HarnessAdapter>>) which carries the actual
 * spawn/resume/doctor implementations — this registry is the source of truth
 * for what harnesses exist, their mode (embedded vs external), and their
 * per-harness metadata (installMcpPrompt, detectInstalled).
 *
 * Adding a harness = one adapter file + one line in HARNESS_ADAPTER_INFOS.
 */
import { HarnessError } from "../errors.js";
import type { HarnessAdapterInfo } from "./adapter.js";
import { claudeCodeAdapterInfo } from "./claude-code-info.js";
import { codexAdapterInfo } from "./codex-info.js";
import { piAdapterInfo } from "./pi.js";
import { opencodeAdapterInfo } from "./opencode.js";
import { conductorAdapterInfo } from "./conductor.js";

/** Every built-in adapter descriptor, in presentation order. */
export const HARNESS_ADAPTER_INFOS: readonly HarnessAdapterInfo[] = [
  claudeCodeAdapterInfo,
  codexAdapterInfo,
  piAdapterInfo,
  opencodeAdapterInfo,
  conductorAdapterInfo,
];

/** Thrown by registry lookups when no adapter has the requested id. */
export class UnknownHarnessAdapterError extends HarnessError {
  constructor(id: string, knownIds: readonly string[]) {
    super(
      "UNKNOWN_HARNESS_ADAPTER",
      `Unknown harness adapter: ${JSON.stringify(id)}. Known adapters: ${knownIds.join(", ")}.`,
    );
  }
}

/** Read-only view over the adapter registry. */
export interface HarnessAdapterRegistry {
  /** All adapters, in registration order. The array is frozen. */
  list(): readonly HarnessAdapterInfo[];
  /**
   * The adapter with the given id. Accepts any string (ids often come from
   * config files or HTTP bodies) and throws {@link UnknownHarnessAdapterError}
   * when nothing matches.
   */
  get(id: string): HarnessAdapterInfo;
}

/**
 * Build a registry from an adapter list. Duplicate ids are a programming
 * error and throw at construction time rather than at lookup time.
 */
export function createHarnessAdapterRegistry(
  adapters: readonly HarnessAdapterInfo[],
): HarnessAdapterRegistry {
  const byId = new Map<string, HarnessAdapterInfo>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw new HarnessError(
        "DUPLICATE_HARNESS_ADAPTER",
        `Duplicate harness adapter id: ${adapter.id}`,
      );
    }
    byId.set(adapter.id, adapter);
  }

  const frozen = Object.freeze([...adapters]);

  return {
    list: () => frozen,
    get: (id) => {
      const adapter = byId.get(id);
      if (!adapter) {
        throw new UnknownHarnessAdapterError(id, [...byId.keys()]);
      }
      return adapter;
    },
  };
}

const defaultRegistry = createHarnessAdapterRegistry(HARNESS_ADAPTER_INFOS);

/** All registered adapter descriptors, in registration order. */
export function listHarnessAdapters(): readonly HarnessAdapterInfo[] {
  return defaultRegistry.list();
}

/** Resolve an adapter descriptor by id. Throws {@link UnknownHarnessAdapterError}. */
export function getHarnessAdapter(id: string): HarnessAdapterInfo {
  return defaultRegistry.get(id);
}
