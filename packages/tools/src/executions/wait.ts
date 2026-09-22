import {
  ExecutionError,
  ExecutionFailedError,
  ExecutionHttpError,
  ExecutionIndeterminateError,
  ExecutionInterruptedError,
  ExecutionProtocolError,
  ExecutionTransportError,
  ExecutionWaitInterruptedError,
} from "./errors.js";
import { pause, positiveMs, type ExecutionRequestOptions } from "./http.js";
import type { ExecutionReference, ExecutionState } from "./types.js";

export interface ExecutionWaitOptions extends ExecutionRequestOptions {
  /** Local waiting budget (default 5 minutes). Does not change the server deadline. */
  waitTimeoutMs?: number;
  initialPollIntervalMs?: number;
  maxPollIntervalMs?: number;
}

export async function waitForExecution<T>(
  get: (options: ExecutionRequestOptions) => Promise<ExecutionState<T>>,
  reference: ExecutionReference,
  options: ExecutionWaitOptions,
  capabilityId?: string,
): Promise<T> {
  const deadline =
    Date.now() + positiveMs(options.waitTimeoutMs ?? 300_000, "waitTimeoutMs");
  const initial = positiveMs(
    options.initialPollIntervalMs ?? 500,
    "initialPollIntervalMs",
  );
  const cap = positiveMs(
    options.maxPollIntervalMs ?? 5000,
    "maxPollIntervalMs",
  );
  const requestCap = positiveMs(
    options.requestTimeoutMs ?? 15_000,
    "requestTimeoutMs",
  );
  if (initial > cap)
    throw new ExecutionProtocolError(
      "Initial poll interval exceeds its maximum.",
      reference,
    );
  const stopped = () =>
    new ExecutionWaitInterruptedError(
      "Execution wait stopped; accepted work continues. Resume with the saved ID or handle.",
      reference,
    );
  let interval = initial;
  try {
    for (;;) {
      if (options.signal?.aborted || Date.now() >= deadline) throw stopped();
      let retryAfter: number | undefined;
      try {
        const state = await get({
          ...options,
          requestTimeoutMs: Math.min(requestCap, deadline - Date.now()),
        });
        if (capabilityId && state.capabilityId !== capabilityId)
          throw new ExecutionProtocolError(
            "Execution capability does not match the saved handle.",
            reference,
          );
        if (state.status === "succeeded") return state.result;
        if (state.status === "failed")
          throw new ExecutionFailedError(state.error, reference);
        if (state.status === "indeterminate")
          throw new ExecutionIndeterminateError(state.error, reference);
      } catch (error) {
        if (error instanceof ExecutionError) Object.assign(error, reference);
        const transient =
          error instanceof ExecutionTransportError ||
          (error instanceof ExecutionHttpError &&
            [429, 502, 503, 504].includes(error.status));
        if (!transient) throw error;
        if (error instanceof ExecutionHttpError)
          retryAfter = error.retryAfterMs;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw stopped();
      const delay =
        retryAfter ?? Math.min(cap, interval * (0.8 + Math.random() * 0.4));
      await pause(Math.min(remaining, delay), options.signal, reference);
      interval = Math.min(cap, interval * 2);
    }
  } catch (error) {
    if (error instanceof ExecutionInterruptedError) throw stopped();
    throw error;
  }
}
