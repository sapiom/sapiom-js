/**
 * The one pure function from a description of agents to the map. A scan of a project folder
 * and a caller's own description both end here, so the same facts always draw the same map:
 * every list is sorted and nothing depends on input order, time or the filesystem.
 */
import { createHash } from "node:crypto";

import type {
  AgentMap,
  DescribedAgent,
  DescribedTrigger,
  EdgeKind,
  Evidence,
  MapAgent,
  MapDescription,
  MapEdge,
  MapSystem,
  Unresolved,
} from "./types.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEvidence(left: Evidence, right: Evidence): number {
  return (
    compareText(left.file, right.file) ||
    left.line - right.line ||
    compareText(left.text, right.text) ||
    compareText(left.step ?? "", right.step ?? "")
  );
}

function evidenceKey(evidence: Evidence): string {
  return `${evidence.file}\0${evidence.line}\0${evidence.text}\0${evidence.step ?? ""}`;
}

function uniqueEvidence(items: readonly Evidence[]): Evidence[] {
  const byKey = new Map<string, Evidence>();
  for (const item of items) {
    const clean: Evidence = { file: item.file, line: item.line, text: item.text };
    if (item.step) clean.step = item.step;
    byKey.set(evidenceKey(clean), clean);
  }
  return [...byKey.values()].sort(compareEvidence);
}

function triggerKey(trigger: DescribedTrigger): string {
  return trigger.kind === "event"
    ? `event\0${trigger.eventType}\0${trigger.source}`
    : `schedule\0${trigger.cron ?? ""}\0${trigger.source}`;
}

function normalizeTriggers(triggers: readonly DescribedTrigger[]): DescribedTrigger[] {
  const byKey = new Map<string, DescribedTrigger>();
  for (const trigger of triggers) {
    const key = triggerKey(trigger);
    const evidence = uniqueEvidence([
      ...(byKey.get(key)?.evidence ?? []),
      ...(trigger.evidence ?? []),
    ]);
    const merged: DescribedTrigger =
      trigger.kind === "event"
        ? { kind: "event", eventType: trigger.eventType, source: trigger.source }
        : { kind: "schedule", source: trigger.source };
    if (trigger.kind === "schedule" && trigger.cron) {
      (merged as { cron?: string }).cron = trigger.cron;
    }
    if (evidence.length > 0) merged.evidence = evidence;
    byKey.set(key, merged);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, trigger]) => trigger);
}

/** The system id is a hash of its sorted members, so the same agents give the same id. */
export function systemId(slugs: readonly string[]): string {
  const sorted = [...slugs].sort(compareText);
  return `sys-${createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 12)}`;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  constructor(items: Iterable<string>) {
    for (const item of items) this.parent.set(item, item);
  }

  find(item: string): string {
    let root = item;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let current = item;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(left: string, right: string): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    // The smaller slug stays root so the result never depends on union order.
    if (compareText(a, b) < 0) this.parent.set(b, a);
    else this.parent.set(a, b);
  }
}

interface EdgeDraft {
  from: string;
  to: string;
  kind: EdgeKind;
  eventType?: string;
  evidence: Evidence[];
}

function edgeKey(draft: Pick<EdgeDraft, "from" | "to" | "kind" | "eventType">): string {
  return `${draft.from}\0${draft.to}\0${draft.kind}\0${draft.eventType ?? ""}`;
}

export function buildMap(description: MapDescription): AgentMap {
  const agentsBySlug = new Map<string, DescribedAgent>();
  for (const agent of description.agents) {
    if (agentsBySlug.has(agent.slug)) {
      throw new Error(`Duplicate agent slug "${agent.slug}" in the map description`);
    }
    agentsBySlug.set(agent.slug, agent);
  }
  const slugs = [...agentsBySlug.keys()].sort(compareText);

  const unresolved: Unresolved[] = (description.unresolved ?? []).map((item) => ({
    ...item,
    evidence: uniqueEvidence(item.evidence),
  }));
  const drafts = new Map<string, EdgeDraft>();
  const addEdge = (draft: EdgeDraft): void => {
    const key = edgeKey(draft);
    const existing = drafts.get(key);
    if (existing) existing.evidence.push(...draft.evidence);
    else drafts.set(key, { ...draft, evidence: [...draft.evidence] });
  };

  for (const slug of slugs) {
    const agent = agentsBySlug.get(slug)!;
    for (const call of agent.calls ?? []) {
      if (call.to === slug) continue;
      if (!agentsBySlug.has(call.to)) {
        unresolved.push({
          from: slug,
          kind: call.kind,
          reason: "unknown-target",
          to: call.to,
          evidence: uniqueEvidence(call.evidence ?? []),
        });
        continue;
      }
      addEdge({ from: slug, to: call.to, kind: call.kind, evidence: call.evidence ?? [] });
    }
  }

  // An event edge joins each emitter to every other agent the event type triggers.
  const subscribers = new Map<string, string[]>();
  for (const slug of slugs) {
    for (const trigger of agentsBySlug.get(slug)!.triggers ?? []) {
      if (trigger.kind !== "event") continue;
      const list = subscribers.get(trigger.eventType) ?? [];
      if (!list.includes(slug)) list.push(slug);
      subscribers.set(trigger.eventType, list);
    }
  }
  for (const slug of slugs) {
    for (const emit of agentsBySlug.get(slug)!.emits ?? []) {
      for (const subscriber of subscribers.get(emit.eventType) ?? []) {
        if (subscriber === slug) continue;
        addEdge({
          from: slug,
          to: subscriber,
          kind: "event",
          eventType: emit.eventType,
          evidence: emit.evidence ?? [],
        });
      }
    }
  }

  const edges: MapEdge[] = [...drafts.values()]
    .map((draft) => {
      const evidence = uniqueEvidence(draft.evidence);
      const steps = new Set(evidence.map((item) => item.step));
      const edge: MapEdge = {
        from: draft.from,
        to: draft.to,
        kind: draft.kind,
        evidence,
      };
      if (draft.eventType) edge.eventType = draft.eventType;
      const [onlyStep] = steps;
      if (steps.size === 1 && onlyStep) edge.fromStep = onlyStep;
      return edge;
    })
    .sort(
      (left, right) =>
        compareText(left.from, right.from) ||
        compareText(left.to, right.to) ||
        compareText(left.kind, right.kind) ||
        compareText(left.eventType ?? "", right.eventType ?? ""),
    );

  // Systems: connected components over code-proven edges. Shared resources never join agents.
  const components = new DisjointSet(slugs);
  const neighbours = new Map<string, Set<string>>(slugs.map((slug) => [slug, new Set()]));
  for (const edge of edges) {
    components.union(edge.from, edge.to);
    neighbours.get(edge.from)!.add(edge.to);
    neighbours.get(edge.to)!.add(edge.from);
  }
  const members = new Map<string, string[]>();
  for (const slug of slugs) {
    const root = components.find(slug);
    members.set(root, [...(members.get(root) ?? []), slug]);
  }
  const fileNames = [...(description.names ?? [])].sort(
    (left, right) => compareText(left.agent, right.agent) || compareText(left.name, right.name),
  );
  const systems: MapSystem[] = [...members.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const named = fileNames.find((entry) => group.includes(entry.agent));
      const hub = [...group].sort(
        (left, right) =>
          neighbours.get(right)!.size - neighbours.get(left)!.size || compareText(left, right),
      )[0]!;
      return {
        id: systemId(group),
        name: named?.name ?? hub,
        nameSource: named ? ("file" as const) : ("default" as const),
        agents: group,
      };
    })
    .sort((left, right) => compareText(left.agents[0]!, right.agents[0]!));

  // A chip only for a resource another agent in the map also uses.
  const resourceUsers = new Map<string, Set<string>>();
  for (const slug of slugs) {
    for (const resource of agentsBySlug.get(slug)!.resources ?? []) {
      const users = resourceUsers.get(resource) ?? new Set<string>();
      users.add(slug);
      resourceUsers.set(resource, users);
    }
  }

  const agents: MapAgent[] = slugs.map((slug) => {
    const agent = agentsBySlug.get(slug)!;
    const shared = [...new Set(agent.resources ?? [])]
      .filter((resource) => (resourceUsers.get(resource)?.size ?? 0) > 1)
      .sort(compareText);
    const mapped: MapAgent = {
      slug,
      path: agent.path ?? "",
      description: agent.description ?? "",
      deployed: agent.deployed ?? null,
      changedSinceRef: agent.changedSinceRef ?? false,
      shared,
      triggers: normalizeTriggers(agent.triggers ?? []),
    };
    if (agent.steps) mapped.steps = agent.steps;
    else if (agent.stepsUnavailable) mapped.stepsUnavailable = agent.stepsUnavailable;
    return mapped;
  });

  const map: AgentMap = {
    root: description.root,
    systems,
    agents,
    edges,
    unresolved: unresolved.sort(
      (left, right) =>
        compareText(left.from, right.from) ||
        compareText(left.kind, right.kind) ||
        compareText(left.to ?? "", right.to ?? "") ||
        compareEvidence(
          left.evidence[0] ?? { file: "", line: 0, text: "" },
          right.evidence[0] ?? { file: "", line: 0, text: "" },
        ),
    ),
    platform: description.platform ?? "skipped",
    labels: "unavailable",
  };
  if (description.ref !== undefined) map.ref = description.ref;
  return map;
}
