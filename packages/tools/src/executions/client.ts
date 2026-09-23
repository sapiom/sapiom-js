import { randomUUID } from "node:crypto";
import { Transport, resolveCoreBaseUrl } from "../_client/index.js";
import {
  ExecutionHttpError,
  ExecutionInterruptedError,
  ExecutionProtocolError,
  ExecutionTransportError,
  ExecutionWaitInterruptedError,
} from "./errors.js";
import {
  executionRequest,
  pause,
  type ExecutionRequestOptions,
} from "./http.js";
import {
  isRecord,
  normalizeBaseUrl,
  parseExecution,
  validateCapability,
  validateId,
  validateKey,
} from "./protocol.js";
import type {
  ExecutionHandle,
  ExecutionReceipt,
  ExecutionState,
  ExecutionSubmission,
} from "./types.js";
import { waitForExecution, type ExecutionWaitOptions } from "./wait.js";

export interface ExecutionPrepareOptions {
  submissionKey?: string;
  baseUrl?: string;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

/** One authenticated client; descriptors/handles contain no credentials. */
export class ExecutionClient {
  constructor(private readonly transport: Transport) {}

  private base(options: { baseUrl?: string }): string {
    return normalizeBaseUrl(
      options.baseUrl ?? this.transport.coreBaseUrl ?? resolveCoreBaseUrl(),
    );
  }

  prepare(
    capabilityId: string,
    request: Record<string, unknown>,
    options: ExecutionPrepareOptions = {},
  ): ExecutionSubmission {
    validateCapability(capabilityId);
    const submissionKey = options.submissionKey ?? randomUUID();
    validateKey(submissionKey);
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(JSON.stringify(request));
    } catch {
      throw new ExecutionProtocolError(
        "Execution request must be a JSON object.",
        { submissionKey },
      );
    }
    if (!isRecord(snapshot))
      throw new ExecutionProtocolError(
        "Execution request must be a JSON object.",
        { submissionKey },
      );
    return freeze({
      version: 1,
      capabilityId,
      request: snapshot,
      submissionKey,
      coreBaseUrl: this.base(options),
    });
  }

  async submit(
    submission: ExecutionSubmission,
    options: ExecutionRequestOptions = {},
  ): Promise<ExecutionHandle> {
    const reference = { submissionKey: submission.submissionKey };
    if (
      submission.version !== 1 ||
      normalizeBaseUrl(submission.coreBaseUrl) !== this.base(options)
    )
      throw new ExecutionProtocolError(
        "Saved submission version or configured Core base URL does not match.",
        reference,
      );
    // Revalidate persisted JSON, then snapshot once before any asynchronous attempt.
    const saved = this.prepare(submission.capabilityId, submission.request, {
      ...options,
      submissionKey: submission.submissionKey,
    });
    const body = JSON.stringify(saved.request);
    const transport = this.transport.withAttribution({});
    const headers = { ...options.headers };
    const deadline = Date.now() + 30_000;
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new ExecutionInterruptedError(
          "Submission wait expired; acceptance may be unknown.",
          reference,
        );
      try {
        const raw = await executionRequest(
          transport,
          `${saved.coreBaseUrl}/v1/capabilities/${encodeURIComponent(saved.capabilityId)}/executions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Idempotency-Key": saved.submissionKey,
            },
            body,
          },
          {
            ...options,
            headers,
            requestTimeoutMs: Math.min(
              options.requestTimeoutMs ?? 15_000,
              remaining,
            ),
          },
          reference,
        );
        const receipt = parseExecution(
          raw,
          false,
          reference,
          saved.capabilityId,
        ) as ExecutionReceipt;
        return freeze({
          receipt,
          submissionKey: saved.submissionKey,
          coreBaseUrl: saved.coreBaseUrl,
        });
      } catch (error) {
        const retry =
          error instanceof ExecutionTransportError ||
          (error instanceof ExecutionHttpError &&
            [502, 503, 504].includes(error.status) &&
            error.body.code !== "admission_disabled");
        if (!retry || attempt >= 2) throw error;
        await pause(
          Math.max(0, Math.min(100 * 2 ** attempt, deadline - Date.now())),
          options.signal,
          reference,
        );
      }
    }
  }

  async get<T = unknown>(
    executionId: string,
    options: ExecutionRequestOptions = {},
  ): Promise<ExecutionState<T>> {
    validateId(executionId);
    const baseUrl = this.base(options);
    const raw = await executionRequest(
      this.transport,
      `${baseUrl}/v1/capability-executions/${executionId}`,
      { method: "GET" },
      options,
      { executionId },
    );
    const state = parseExecution<T>(raw, true, {
      executionId,
    }) as ExecutionState<T>;
    this.transport.observeExecution(baseUrl, state);
    return state;
  }

  async wait<T = unknown>(
    execution: string | ExecutionHandle,
    options: ExecutionWaitOptions = {},
  ): Promise<T> {
    const baseUrl = this.base(options);
    const reference =
      typeof execution === "string"
        ? { executionId: execution }
        : {
            executionId: execution.receipt.id,
            submissionKey: execution.submissionKey,
          };
    if (typeof execution !== "string") {
      validateKey(execution.submissionKey);
      parseExecution(execution.receipt, false, reference);
      if (normalizeBaseUrl(execution.coreBaseUrl) !== baseUrl)
        throw new ExecutionProtocolError(
          "Saved handle and configured Core base URL do not match.",
          reference,
        );
    }
    validateId(reference.executionId);
    try {
      return await waitForExecution<T>(
        (request) =>
          this.get<T>(reference.executionId, { ...request, baseUrl }),
        reference,
        options,
        typeof execution === "string"
          ? undefined
          : execution.receipt.capabilityId,
      );
    } catch (error) {
      if (error instanceof ExecutionWaitInterruptedError)
        this.transport.observeExecutionWaitInterrupted(reference.executionId);
      throw error;
    }
  }
}
