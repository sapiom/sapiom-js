import { createHash } from "node:crypto";

import type {
  AgentMapGraph,
  AgentMapVersion,
  GraphContentDigest,
  RecordDigest,
} from "./agent-map.js";

import {
  canonicalJson,
  canonicalizeAgentMapGraph,
} from "./agent-map-canonical-pure.js";
export {
  canonicalJson,
  canonicalizeAgentMapGraph,
  compareCanonicalStrings,
} from "./agent-map-canonical-pure.js";

export const canonicalDigest = (domain: string, value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;

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
