import type { Transport } from "../_client/index.js";
import {
  ExecutionError,
  ExecutionExpiredError,
  ExecutionHttpError,
  ExecutionInterruptedError,
  ExecutionProtocolError,
  ExecutionTransportError,
} from "./errors.js";
import { isRecord } from "./protocol.js";
import type { ExecutionReference } from "./types.js";

export interface ExecutionRequestOptions {
  baseUrl?: string;
  signal?: AbortSignal;
  /** Per-request cap; defaults to 15 seconds, never exceeds 15 seconds. */
  requestTimeoutMs?: number;
}
export function positiveMs(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)
    throw new ExecutionProtocolError(
      `${name} must be a finite positive duration.`,
    );
  return value;
}

/** Bounds fetch AND response-body reading, including injected fetches ignoring abort. */
export async function bounded<T>(
  ms: number,
  signal: AbortSignal | undefined,
  reference: ExecutionReference,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(
        new ExecutionInterruptedError(
          "Execution request interrupted; accepted work continues.",
          reference,
        ),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new ExecutionTransportError("Execution request timed out.", reference),
      );
    }, ms);
    if (signal?.aborted) onAbort();
  });
  try {
    if (signal?.aborted) return await interrupted;
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function pause(
  ms: number,
  signal: AbortSignal | undefined,
  reference: ExecutionReference,
): Promise<void> {
  if (signal?.aborted)
    throw new ExecutionInterruptedError(
      "Execution wait interrupted; accepted work continues.",
      reference,
    );
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(
        new ExecutionInterruptedError(
          "Execution wait interrupted; accepted work continues.",
          reference,
        ),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export async function executionRequest(
  transport: Transport,
  url: string,
  init: RequestInit,
  options: ExecutionRequestOptions,
  reference: ExecutionReference,
): Promise<unknown> {
  return bounded(
    Math.min(
      15_000,
      positiveMs(options.requestTimeoutMs ?? 15_000, "requestTimeoutMs"),
    ),
    options.signal,
    reference,
    async (signal) => {
      try {
        const response = await transport.fetch(
          url,
          { ...init, signal, redirect: "error" },
          { authHeader: "x-api-key" },
        );
        if (response.redirected)
          throw new ExecutionProtocolError(
            "Execution redirects are not supported.",
            reference,
          );
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          if (response.ok)
            throw new ExecutionProtocolError(
              "Invalid execution JSON response.",
              reference,
            );
        }
        if (!response.ok) {
          if (response.status === 410)
            throw new ExecutionExpiredError(
              "Execution payload expired; do not resubmit with a new key.",
              reference,
            );
          const safe = isRecord(body)
            ? {
                ...(typeof body.code === "string" ? { code: body.code } : {}),
                ...(typeof body.message === "string"
                  ? { message: body.message }
                  : {}),
              }
            : {};
          const header = response.headers.get("retry-after");
          const delay =
            header === null
              ? undefined
              : /^\d+(?:\.\d+)?$/.test(header)
                ? Number(header) * 1000
                : Date.parse(header) - Date.now();
          throw new ExecutionHttpError(
            response.status,
            safe,
            reference,
            delay !== undefined && Number.isFinite(delay)
              ? Math.max(0, delay)
              : undefined,
          );
        }
        if (
          ![200, 202].includes(response.status) ||
          (init.method !== "POST" && response.status !== 200)
        )
          throw new ExecutionProtocolError(
            "Unexpected execution response status.",
            reference,
          );
        return body;
      } catch (error) {
        if (error instanceof ExecutionError) throw error;
        // Never put request data, credential-bearing fetch messages or raw bodies in errors.
        throw new ExecutionTransportError(
          "Execution request failed; acceptance may be unknown.",
          reference,
        );
      }
    },
  );
}
