/**
 * Registry mechanics for harness adapters: id-based lookup with a typed
 * error, plus a factory so the adapter set stays pure data — registering
 * a harness is appending one entry to an array.
 */
import { HarnessError } from "../runtime/errors.js";
import type { HarnessAdapter } from "./adapter.js";

/** Thrown by registry lookups when no adapter has the requested id. */
export class UnknownHarnessError extends HarnessError {
  readonly code = "UNKNOWN_HARNESS";

  constructor(id: string, knownIds: readonly string[]) {
    super(
      `Unknown harness: ${JSON.stringify(id)}. ` +
        `Known harnesses: ${knownIds.join(", ")}.`,
    );
  }
}

/** Enumeration and lookup over a fixed set of adapters. */
export interface HarnessRegistry {
  /** All adapters, in registration order. The array is frozen. */
  list(): readonly HarnessAdapter[];
  /**
   * The adapter with the given id. Accepts any string (ids often arrive
   * from config files or HTTP) and throws {@link UnknownHarnessError}
   * when nothing matches.
   */
  get(id: string): HarnessAdapter;
}

/**
 * Build a registry from an adapter list. Duplicate ids are a programming
 * error and throw immediately.
 */
export function createHarnessRegistry(
  adapters: readonly HarnessAdapter[],
): HarnessRegistry {
  const byId = new Map<string, HarnessAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw new HarnessError(`Duplicate harness adapter id: ${adapter.id}`);
    }
    byId.set(adapter.id, adapter);
  }

  const frozen = Object.freeze([...adapters]);

  return {
    list: () => frozen,
    get: (id) => {
      const adapter = byId.get(id);
      if (!adapter) throw new UnknownHarnessError(id, [...byId.keys()]);
      return adapter;
    },
  };
}
