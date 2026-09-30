import { defaultTransport } from "../_client/index.js";
import { ExecutionClient, prepareExecution } from "./client.js";
import type { ExecutionRequestOptions } from "./http.js";
import type { ExecutionSubmission } from "./types.js";

export * from "./types.js";
export * from "./errors.js";
export type { ExecutionClient, ExecutionPrepareOptions } from "./client.js";
export type { ExecutionRequestOptions } from "./http.js";
export const prepare = prepareExecution;
export const submit = (
  submission: ExecutionSubmission,
  options?: ExecutionRequestOptions,
) => new ExecutionClient(defaultTransport()).submit(submission, options);
export const get = <T = unknown>(
  executionId: string,
  options?: ExecutionRequestOptions,
) => new ExecutionClient(defaultTransport()).get<T>(executionId, options);
