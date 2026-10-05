/**
 * Which runs belong to which agent, and which one each agent shows (pure).
 *
 * Runs are keyed by the agent's PATH, never by a session (design-map-chat.md
 * §1 "Run", I3; flow 4.4b). Run locally and Run are direct routes that take no
 * session, so a run started from the agent modal with no session open must
 * still land under the agent it ran. Keying by session dropped exactly that
 * run: there was no session to file it under.
 *
 * The snapshots themselves live in `runsByExecution` (keyed by executionId,
 * never dropped); this module only holds the per-agent order and the explicit
 * pick, so a past run stays inspectable after a newer one starts.
 */
import { samePath } from "./paths";

export interface AgentRunIndex {
  /** Ordered executionIds per agent path, oldest first: the run picker's
   *  source of truth. */
  idsByAgent: Map<string, string[]>;
  /** Explicit run picks per agent path; absent = follow the latest run. */
  pickedByAgent: Map<string, string>;
}

export const emptyAgentRunIndex = (): AgentRunIndex => ({
  idsByAgent: new Map(),
  pickedByAgent: new Map(),
});

/**
 * The map's own key for `agentPath`. Paths arrive from the registry, the run
 * request and a session's binding; they can differ in a trailing separator or
 * (on Windows) case, and two keys for one agent would split its runs in two.
 */
const keyFor = (map: Map<string, unknown>, agentPath: string): string => {
  for (const key of map.keys()) if (samePath(key, agentPath)) return key;
  return agentPath;
};

/**
 * Files a newly observed run under its agent and drops the agent's explicit
 * pick, so the agent follows its fresh run (the picker still reaches every
 * past one). A repeat announcement of the same run changes nothing.
 */
export function recordAgentRun(
  index: AgentRunIndex,
  agentPath: string,
  executionId: string,
): AgentRunIndex {
  const key = keyFor(index.idsByAgent, agentPath);
  const ids = index.idsByAgent.get(key) ?? [];
  if (ids.includes(executionId)) return index;
  const idsByAgent = new Map(index.idsByAgent).set(key, [...ids, executionId]);
  const pickKey = keyFor(index.pickedByAgent, agentPath);
  if (!index.pickedByAgent.has(pickKey)) return { ...index, idsByAgent };
  const pickedByAgent = new Map(index.pickedByAgent);
  pickedByAgent.delete(pickKey);
  return { idsByAgent, pickedByAgent };
}

/** Shows a past run of the agent instead of its latest. */
export function pickAgentRun(
  index: AgentRunIndex,
  agentPath: string,
  executionId: string,
): AgentRunIndex {
  const key = keyFor(index.pickedByAgent, agentPath);
  if (index.pickedByAgent.get(key) === executionId) return index;
  return {
    ...index,
    pickedByAgent: new Map(index.pickedByAgent).set(key, executionId),
  };
}

/**
 * Re-files an agent's runs after Change location moved it, so its history
 * follows it to the new path instead of staying under a path nothing shows.
 */
export function moveAgentRuns(
  index: AgentRunIndex,
  from: string,
  to: string,
): AgentRunIndex {
  const move = <V>(map: Map<string, V>): Map<string, V> => {
    const key = keyFor(map, from);
    if (!map.has(key)) return map;
    const next = new Map(map);
    const value = next.get(key) as V;
    next.delete(key);
    return next.set(to, value);
  };
  const idsByAgent = move(index.idsByAgent);
  const pickedByAgent = move(index.pickedByAgent);
  return idsByAgent === index.idsByAgent && pickedByAgent === index.pickedByAgent
    ? index
    : { idsByAgent, pickedByAgent };
}

/**
 * The executionId each agent shows: its pick while that run is still filed
 * under it, else its latest run.
 */
export function shownRunIdByAgent(index: AgentRunIndex): Map<string, string> {
  const shown = new Map<string, string>();
  index.idsByAgent.forEach((ids, agentPath) => {
    const picked = index.pickedByAgent.get(agentPath);
    const id = picked && ids.includes(picked) ? picked : ids[ids.length - 1];
    if (id) shown.set(agentPath, id);
  });
  return shown;
}

/** The agent's run ids, oldest first, whatever spelling of its path is asked. */
export function runIdsForAgent(
  index: AgentRunIndex,
  agentPath: string,
): string[] {
  return index.idsByAgent.get(keyFor(index.idsByAgent, agentPath)) ?? [];
}
