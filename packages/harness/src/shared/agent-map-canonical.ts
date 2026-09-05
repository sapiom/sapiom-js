import { createHash } from "node:crypto";

import type {
  AgentMapGraph,
  AgentMapVersion,
  GraphContentDigest,
  PlanNode,
  PlanRelationship,
  RecordDigest,
} from "./agent-map.js";

export const compareCanonicalStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizedLineEndings = (value: string): string =>
  value.replace(/\r\n?/gu, "\n");

/** RFC-8259-shaped canonical JSON with binary key ordering and normalized text. */
export function canonicalJson(value: unknown): string {
  const visit = (entry: unknown): unknown => {
    if (entry === undefined) throw new TypeError("undefined is not canonical JSON");
    if (typeof entry === "string") return normalizedLineEndings(entry);
    if (typeof entry === "number" && !Number.isFinite(entry))
      throw new TypeError("non-finite number is not canonical JSON");
    if (
      entry === null ||
      typeof entry === "boolean" ||
      typeof entry === "number"
    )
      return entry;
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry === "object") {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("non-plain object is not canonical JSON");
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => compareCanonicalStrings(left, right))
          .map(([key, field]) => [key, visit(field)]),
      );
    }
    throw new TypeError("unsupported canonical JSON value");
  };
  return JSON.stringify(visit(value));
}

export const canonicalDigest = (domain: string, value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;

const canonicalNode = (node: PlanNode): PlanNode => ({
  ...node,
  contractRefs: [...node.contractRefs].sort(compareCanonicalStrings),
});

const canonicalRelationship = (
  relationship: PlanRelationship,
): PlanRelationship => ({ ...relationship });

/** Return a defensive graph copy in the semantic digest protocol order. */
export function canonicalizeAgentMapGraph(graph: AgentMapGraph): AgentMapGraph {
  const nodes = graph.nodes
    .map(canonicalNode)
    .sort((left, right) => compareCanonicalStrings(left.id, right.id));
  const relationships = graph.relationships
    .map(canonicalRelationship)
    .sort((left, right) => compareCanonicalStrings(left.id, right.id));
  if (new Set(nodes.map(({ id }) => id)).size !== nodes.length)
    throw new TypeError("duplicate Agent Map node ID");
  if (new Set(relationships.map(({ id }) => id)).size !== relationships.length)
    throw new TypeError("duplicate Agent Map relationship ID");
  if (
    nodes.some(
      ({ contractRefs }) => new Set(contractRefs).size !== contractRefs.length,
    )
  )
    throw new TypeError("duplicate Agent Map contract reference");
  return { nodes, relationships };
}

export const computeGraphContentDigest = (
  graph: AgentMapGraph,
): GraphContentDigest =>
  canonicalDigest(
    "sapiom.agent-map.content.v1",
    canonicalizeAgentMapGraph(graph),
  ) as GraphContentDigest;

export const computeAgentMapVersionRecordDigest = (
  version: Omit<AgentMapVersion, "recordDigest"> | AgentMapVersion,
): RecordDigest => {
  const record = Object.fromEntries(
    Object.entries(version).filter(([key]) => key !== "recordDigest"),
  );
  return canonicalDigest(
    "sapiom.agent-map.version-record.v1",
    record,
  ) as RecordDigest;
};

/** Compatibility alias for callers introduced before the neutral vocabulary. */
export const computeArchitectureGraphDigest = computeGraphContentDigest;
