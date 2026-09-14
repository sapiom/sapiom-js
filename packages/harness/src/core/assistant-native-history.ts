import { basename } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import {
  openCodeTransportFailure,
  type OpenCodeTransportFailure,
} from "../shared/opencode-errors.js";
import {
  awaitAssistantInspection,
  type AssistantAttachment,
  type AssistantLifecycleCoordinator,
} from "./assistant-lifecycle.js";
import {
  assistantResumeBindingDigest,
  type AssistantAssociation,
} from "./assistant-session-store.js";
import {
  OpenCodeAccessError,
  OpenCodeTransportError,
  type HostedOpenCode,
} from "./opencode-host.js";

/** Server-only result: never serialize savedSystem into a public history entry. */
export interface AssistantNativeInspection {
  nativeHistory: "available" | "missing" | "unavailable";
  nativeResume: "available" | "missing" | "unavailable";
  resumeFailure?: OpenCodeTransportFailure;
  savedSystem?: string;
  sourceMessageId?: string;
}
interface Options {
  authorize: (id: string) => Promise<AssistantAssociation | null>;
  lifecycle: Pick<AssistantLifecycleCoordinator, "inspect"> &
    Partial<Pick<AssistantLifecycleCoordinator, "resume">>;
  /** The shared delivery.recover preflight; validates retained content without dispatch. */
  preflight: (
    hosted: HostedOpenCode,
    conversationId: string,
    savedSystem: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  timeoutMs?: number;
}
const unavailable = () =>
  new OpenCodeTransportError(openCodeTransportFailure("transport_unavailable"));
const contextUnavailable = () =>
  new OpenCodeTransportError(openCodeTransportFailure("context_unavailable"));
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  return value as Record<string, unknown>;
};

async function json(
  response: Response,
  signal: AbortSignal,
  limit: number,
): Promise<unknown> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new OpenCodeTransportError(
      openCodeTransportFailure(
        response.status === 404
          ? "native_history_missing"
          : "transport_unavailable",
      ),
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await awaitAssistantInspection(
        reader.read(),
        signal,
      );
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw unavailable();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Keep native availability separate from execution readiness. No association
 * creation, source substitution, prompt, or model call is permitted here. */
export class AssistantNativeHistory {
  constructor(private readonly options: Options) {}

  /** Retain the coordinator's exact validated runtime; never inspect/retire it
   * first or return private saved context in the public attachment. */
  async resume(
    id: string,
    expectedRevision: number,
    operationId: string,
  ): Promise<AssistantAttachment> {
    if (!this.options.lifecycle.resume) throw unavailable();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(unavailable()),
      this.options.timeoutMs ?? 15_000,
    );
    try {
      return await this.options.lifecycle.resume(
        id,
        expectedRevision,
        operationId,
        {
          authorize: (signal) => this.authorized(id, signal),
          read: (hosted, binding, signal) =>
            this.read(hosted, binding, signal, {
              nativeHistory: "unavailable",
            }),
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async inspect(
    id: string,
    expectedRevision: number,
  ): Promise<AssistantNativeInspection> {
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(
      () => controller.abort(unavailable()),
      this.options.timeoutMs ?? 15_000,
    );
    const observed: Pick<AssistantNativeInspection, "nativeHistory"> = {
      nativeHistory: "unavailable",
    };
    try {
      const binding = await this.authorized(id, signal);
      const result = await this.options.lifecycle.inspect(
        id,
        expectedRevision,
        (hosted, readSignal) =>
          this.read(hosted, binding, readSignal, observed),
        signal,
      );
      // The provisional runtime has now retired; refresh authority after cleanup IO.
      await this.assertBinding(binding, signal);
      return result;
    } catch (error) {
      const code =
        error instanceof OpenCodeTransportError
          ? error.failure.code
          : "transport_unavailable";
      if (
        ["access_denied", "access_expired", "authentication_required"].includes(
          code,
        )
      )
        throw error;
      const missing =
        code === "native_history_missing" &&
        observed.nativeHistory !== "available";
      return {
        nativeHistory: missing ? "missing" : observed.nativeHistory,
        nativeResume: missing ? "missing" : "unavailable",
        resumeFailure:
          code === "runtime_start_failed"
            ? openCodeTransportFailure(
                code,
                error instanceof OpenCodeTransportError
                  ? error.failure.reason
                  : undefined,
              )
            : openCodeTransportFailure(code),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async authorized(
    id: string,
    signal: AbortSignal,
  ): Promise<AssistantAssociation> {
    const binding = await awaitAssistantInspection(
      this.options.authorize(id),
      signal,
    );
    try {
      if (
        !binding ||
        binding.harnessSessionId !== id ||
        binding.conversationId === id
      )
        throw new Error("invalid binding");
      assistantResumeBindingDigest(binding);
      return { ...binding };
    } catch {
      throw new OpenCodeAccessError("Assistant binding unavailable");
    }
  }

  private async assertBinding(
    binding: AssistantAssociation,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.authorized(binding.harnessSessionId, signal);
    if (
      assistantResumeBindingDigest(current) !==
      assistantResumeBindingDigest(binding)
    )
      throw new OpenCodeAccessError("Assistant binding changed");
  }

  private async read(
    hosted: HostedOpenCode,
    binding: AssistantAssociation,
    readSignal: AbortSignal,
    observed: Pick<AssistantNativeInspection, "nativeHistory">,
  ): Promise<AssistantNativeInspection> {
    if (
      hosted.harnessSessionId !== binding.harnessSessionId ||
      hosted.cwd !== binding.cwd ||
      hosted.contextAuthorityScope !== binding.contextAuthorityScope ||
      basename(hosted.stateRoot) !== binding.nativeScope
    )
      throw new OpenCodeAccessError("Assistant binding changed");
    const get = async (path: string, limit: number) =>
      json(
        await awaitAssistantInspection(
          hosted.server.fetch(path, {
            method: "GET",
            signal: readSignal,
          }),
          readSignal,
        ),
        readSignal,
        limit,
      );
    const session = object(
      await get(`/session/${binding.conversationId}`, 64 * 1024),
    );
    if (
      session.id !== binding.conversationId ||
      (session.directory !== undefined && session.directory !== binding.cwd)
    )
      throw unavailable();
    const history = await get(
      `/session/${binding.conversationId}/message`,
      16 * 1024 * 1024,
    );
    let source: ReturnType<AssistantNativeHistory["source"]>;
    try {
      source = this.source(history, binding.conversationId);
    } catch (error) {
      if (
        error instanceof OpenCodeTransportError &&
        error.failure.code === "context_unavailable"
      )
        observed.nativeHistory = "available";
      throw error;
    }
    observed.nativeHistory = "available";
    if (source) {
      if (typeof source.system !== "string" || !source.system.trim())
        throw contextUnavailable();
      try {
        await awaitAssistantInspection(
          this.options.preflight(
            hosted,
            binding.conversationId,
            source.system,
            readSignal,
          ),
          readSignal,
        );
      } catch (error) {
        readSignal.throwIfAborted();
        throw error instanceof OpenCodeTransportError
          ? error
          : contextUnavailable();
      }
    }
    readSignal.throwIfAborted();
    await this.assertBinding(binding, readSignal);
    return {
      nativeHistory: observed.nativeHistory,
      nativeResume: "available" as const,
      ...(source
        ? {
            savedSystem: source.system as string,
            sourceMessageId: source.id,
          }
        : {}),
    };
  }

  private source(
    value: unknown,
    conversationId: string,
  ): { id: string; system?: unknown } | null {
    if (!Array.isArray(value) || value.length > 10_000) throw unavailable();
    if (!value.length) return null;
    const messages = value
      .map((row) => {
        const message = object(row),
          info = object(message.info),
          time = object(info.time);
        if (
          info.sessionID !== conversationId ||
          typeof info.id !== "string" ||
          !["user", "assistant"].includes(info.role as string) ||
          typeof time.created !== "number" ||
          !Number.isFinite(time.created) ||
          !Array.isArray(message.parts)
        )
          throw unavailable();
        const parts = message.parts.map(object);
        if (
          parts.some(
            (part) =>
              part.sessionID !== conversationId ||
              part.messageID !== info.id ||
              typeof part.type !== "string",
          )
        )
          throw unavailable();
        return { info, parts, created: time.created };
      })
      .sort((a, b) => a.created - b.created);
    const source = messages
      .reverse()
      .find(
        ({ info, parts }) =>
          info.role === "user" &&
          !parts.some(
            (part) =>
              part.type === "compaction" ||
              (part.synthetic &&
                part.metadata &&
                object(part.metadata).compaction_continue === true),
          ),
      );
    if (!source) throw contextUnavailable();
    return { id: source.info.id as string, system: source.info.system };
  }
}
