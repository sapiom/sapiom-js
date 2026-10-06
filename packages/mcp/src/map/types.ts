/**
 * The agent map's two shapes: the description (what a scan of a project folder, or a caller,
 * says about a set of agents) and the map (what `buildMap` computes from it). Nothing here is
 * stored; the map is a pure function of the description.
 */

/** Whether triggers and deploy state came from the signed-in account. */
export type PlatformState = "signed-in" | "signed-out" | "unavailable" | "skipped";

export type EdgeKind = "launch" | "event" | "signal" | "timer";

/** One code location that proves a fact. `file` is POSIX, relative to the map root. */
export interface Evidence {
  file: string;
  line: number;
  text: string;
  /** The step (by declared name) whose `defineStep` block holds the call, when known. */
  step?: string;
}

export interface StepGraph {
  entry: string;
  steps: Array<{ id: string; file?: string; line?: number }>;
  transitions: Array<{ from: string; to: string; kind: string }>;
}

/** A call from this agent to another agent, by slug. */
export interface DescribedCall {
  to: string;
  kind: Exclude<EdgeKind, "event">;
  evidence?: Evidence[];
}

export interface DescribedEmit {
  eventType: string;
  evidence?: Evidence[];
}

export type DescribedTrigger =
  | {
      kind: "event";
      eventType: string;
      source: "code" | "platform";
      evidence?: Evidence[];
    }
  | {
      kind: "schedule";
      cron?: string;
      source: "code" | "platform";
      evidence?: Evidence[];
    };

export interface DescribedAgent {
  slug: string;
  path?: string;
  description?: string;
  deployed?: boolean | null;
  changedSinceRef?: boolean;
  steps?: StepGraph;
  stepsUnavailable?: string;
  calls?: DescribedCall[];
  /** Event types this agent emits. An event edge joins an emitter to each agent triggered by the type. */
  emits?: DescribedEmit[];
  triggers?: DescribedTrigger[];
  /** Resources the agent uses (`vault:KEY`, `db:handle`, `connector:slack`). Only those another agent also uses become chips. */
  resources?: string[];
}

/** A call the scan saw but could not turn into an edge. Never drawn; reported so a caller can see the gap. */
export interface Unresolved {
  from: string;
  kind: EdgeKind;
  reason: "dynamic-target" | "unknown-target";
  to?: string;
  evidence: Evidence[];
}

export interface MapDescription {
  root: string | null;
  /** Present only when `root` is in a git repository. */
  ref?: string;
  agents: DescribedAgent[];
  /** System names from the committed `.sapiom/map.json`: the system holding `agent` is called `name`. */
  names?: Array<{ agent: string; name: string }>;
  unresolved?: Unresolved[];
  /** Where platform facts (triggers, deployed) came from. */
  platform?: PlatformState;
}

export interface MapSystem {
  id: string;
  name: string;
  nameSource: "file" | "default";
  agents: string[];
}

/** A Jev label, present only when its probability clears the threshold (design §4). */
export interface Label<Value extends string> {
  value: Value;
  /** Jev's probability for `value`, rounded to two places. */
  p: number;
}

export type AgentRole = "intake" | "worker" | "orchestrator" | "reporter" | "monitor" | "utility";

export type EdgeLabel = "hands work to" | "feeds data to" | "monitors";

export interface MapAgent {
  slug: string;
  path: string;
  description: string;
  deployed: boolean | null;
  changedSinceRef: boolean;
  shared: string[];
  triggers: DescribedTrigger[];
  steps?: StepGraph;
  stepsUnavailable?: string;
  role?: Label<AgentRole>;
}

export interface MapEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  evidence: Evidence[];
  /** The step that makes the call, when every piece of evidence names the same one. */
  fromStep?: string;
  /** The event type, for an event edge. */
  eventType?: string;
  /** Only on launch and event edges. */
  label?: Label<EdgeLabel>;
}

export interface AgentMap {
  root: string | null;
  ref?: string;
  systems: MapSystem[];
  agents: MapAgent[];
  edges: MapEdge[];
  unresolved: Unresolved[];
  platform: PlatformState;
  /** `buildMap` always says "unavailable"; `labelMap` says "ok" once Jev answered or the cache held every answer. */
  labels: "ok" | "unavailable";
}
