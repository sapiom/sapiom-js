/**
 * A read of a map keyed by agent path that matches the way the run store
 * files it (`agent-run-store.ts` `keyFor`): the registry's spelling of a path
 * and a session binding's can differ in a trailing separator or, on Windows,
 * case, and an exact `Map.get` would show that agent no runs.
 */
import { samePath } from "./paths";

export function getByAgentPath<T>(
  map: ReadonlyMap<string, T>,
  agentPath: string,
): T | undefined {
  const exact = map.get(agentPath);
  if (exact !== undefined) return exact;
  for (const [key, value] of map) if (samePath(key, agentPath)) return value;
  return undefined;
}
