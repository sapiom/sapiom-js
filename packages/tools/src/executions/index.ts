import { defaultTransport } from "../_client/index.js";
import { ExecutionClient, type ExecutionPrepareOptions } from "./client.js";
import type { ExecutionRequestOptions } from "./http.js";
import type { ExecutionSubmission, ExecutionHandle } from "./types.js";
import type { ExecutionWaitOptions } from "./wait.js";

export * from "./types.js";
export * from "./errors.js";
export type { ExecutionClient, ExecutionPrepareOptions } from "./client.js";
export type { ExecutionRequestOptions } from "./http.js";
export type { ExecutionWaitOptions } from "./wait.js";
export const prepare = (
  capabilityId: string,
  request: Record<string, unknown>,
  options?: ExecutionPrepareOptions,
) =>
  new ExecutionClient(defaultTransport()).prepare(
    capabilityId,
    request,
    options,
  );
export const submit = (
  submission: ExecutionSubmission,
  options?: ExecutionRequestOptions,
) => new ExecutionClient(defaultTransport()).submit(submission, options);
export const get = <T = unknown>(
  executionId: string,
  options?: ExecutionRequestOptions,
) => new ExecutionClient(defaultTransport()).get<T>(executionId, options);
export const wait = <T = unknown>(
  execution: string | ExecutionHandle,
  options?: ExecutionWaitOptions,
) => new ExecutionClient(defaultTransport()).wait<T>(execution, options);
