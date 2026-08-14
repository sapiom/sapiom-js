import { exampleFromJsonSchema } from "@sapiom/agent";

import type { WorkflowInputContractResponse } from "../shared/types.js";
import {
  extractWorkflowGraphCached,
  type CachedExtraction,
} from "./canvas-cache.js";

export type InputContractExtractor = (
  sourceDir: string,
) => Promise<CachedExtraction>;

/**
 * Read an agent's entry contract from the same cached, deterministic manifest
 * extraction that powers Canvas. The registered-path boundary lives in the
 * HTTP router; this helper only operates on the already-resolved project.
 */
export async function readWorkflowInputContract(
  sourceDir: string,
  extract: InputContractExtractor = extractWorkflowGraphCached,
): Promise<WorkflowInputContractResponse> {
  const extraction = await extract(sourceDir);
  if (!extraction.result.ok) {
    return {
      status: "unavailable",
      jsonSchema: null,
      example: {},
      reason:
        "Studio couldn't extract this agent's input contract. You can still run it with raw JSON.",
    };
  }

  const { graph } = extraction.result;
  const entry = graph.nodes.find((node) => node.id === graph.entry);
  if (!entry) {
    return {
      status: "unavailable",
      jsonSchema: null,
      example: {},
      reason:
        "Studio couldn't identify the agent's entry step. You can still run it with raw JSON.",
    };
  }

  if (!entry.inputSchema) {
    return { status: "none", jsonSchema: null, example: {} };
  }

  return {
    status: "available",
    jsonSchema: entry.inputSchema,
    example: exampleFromJsonSchema(entry.inputSchema),
  };
}
