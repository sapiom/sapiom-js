import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HostedOpenCode } from "./opencode-host.js";
import { DurableFileLock } from "./durable-file-lock.js";
import { recoverAssistantPrompt } from "./studio-assistant-context.js";
import {
  turnRecoveryAgent,
  openCodeTurn,
  type OpenCodeTurnMessage,
} from "../shared/opencode-turn.js";

export interface PreparedOpenCodePrompt {
  readonly init: RequestInit;
  readonly expectedSystem: string;
}
interface DeliveryOptions {
  assertCurrent?: (hosted: HostedOpenCode) => Promise<void>;
  recoverPrompt?: (
    hosted: HostedOpenCode,
    conversationId: string,
    savedSystem: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ system: string }>;
}
interface PendingAcknowledgement {
  readonly sessionId: string;
  readonly before: ReadonlySet<string | undefined>;
  readonly expectedSystem: string;
}
const ordinaryUser = ({ info, parts }: OpenCodeTurnMessage) =>
  info?.role === "user" &&
  !parts.some((part) => part.type === "compaction" || part.synthetic);
const acknowledges = (
  messages: OpenCodeTurnMessage[],
  pending: PendingAcknowledgement,
) =>
  messages.some(
    (message) =>
      ordinaryUser(message) &&
      !pending.before.has(message.info?.id) &&
      message.info?.system === pending.expectedSystem,
  );

/** One continuation from saved results; never resubmit the original prompt. */
export class OpenCodeFinalResponse {
  private pending = new Map<string, Promise<void>>();
  private admitting = new Set<string>();
  private uncertain = new Set<string>();
  private awaiting = new Map<string, PendingAcknowledgement>();

  constructor(private readonly delivery: DeliveryOptions = {}) {}

  private async current(hosted: HostedOpenCode, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.delivery.assertCurrent?.(hosted);
    signal.throwIfAborted();
    hosted.signal.throwIfAborted();
  }

  isRunning(hosted: HostedOpenCode): boolean {
    return (
      this.pending.has(hosted.stateRoot) || this.admitting.has(hosted.stateRoot)
    );
  }

  async send(
    hosted: HostedOpenCode,
    sessionId: string,
    init:
      | RequestInit
      | ((
          signal: AbortSignal,
        ) => Promise<RequestInit | PreparedOpenCodePrompt>),
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    if (this.isRunning(hosted))
      throw new Error("Another request is being admitted");
    this.admitting.add(hosted.stateRoot);
    const signal = AbortSignal.any([
      hosted.signal,
      AbortSignal.timeout(30_000),
      ...(callerSignal ? [callerSignal] : []),
      ...(typeof init !== "function" && init.signal ? [init.signal] : []),
    ]);
    const history = (requestSignal = signal) =>
      hosted.server.fetchJson<OpenCodeTurnMessage[]>(
        `/session/${sessionId}/message`,
        { signal: requestSignal },
      );
    try {
      if (this.uncertain.has(hosted.stateRoot)) {
        const statuses = await hosted.server.fetchJson<
          Record<string, { type: string }>
        >("/session/status", { signal });
        if (statuses[sessionId] && statuses[sessionId].type !== "idle")
          throw new Error("Previous request is still running");
      }
      // Reconcile earlier uncertainty before accepting another context generation.
      const messages = await history();
      const pending = this.awaiting.get(hosted.stateRoot);
      if (pending) {
        if (pending.sessionId !== sessionId || !acknowledges(messages, pending))
          throw new Error("Previous request has not been reconciled");
        this.awaiting.delete(hosted.stateRoot);
        this.uncertain.delete(hosted.stateRoot);
      }
      const before = new Set(messages.map((message) => message.info?.id));
      signal.throwIfAborted();
      const prepared = typeof init === "function" ? await init(signal) : init;
      const request = "init" in prepared ? prepared.init : prepared;
      const dispatchSignal = AbortSignal.any([
        signal,
        ...(request.signal ? [request.signal] : []),
      ]);
      await this.current(hosted, dispatchSignal);
      const acknowledgement =
        "init" in prepared
          ? { sessionId, before, expectedSystem: prepared.expectedSystem }
          : undefined;
      if (acknowledgement) this.awaiting.set(hosted.stateRoot, acknowledgement);
      this.uncertain.add(hosted.stateRoot);
      const response = await hosted.server.fetch(
        `/session/${sessionId}/prompt_async`,
        { ...request, signal: dispatchSignal },
      );
      if (!response.ok) {
        this.awaiting.delete(hosted.stateRoot);
        return response;
      }
      // A native 204 means scheduled. Keep admission closed until the user
      // message is persisted, so recovery cannot overtake a queued prompt.
      let acknowledged = false;
      while (!acknowledged) {
        dispatchSignal.throwIfAborted();
        const persisted = await history(dispatchSignal);
        acknowledged = acknowledgement
          ? acknowledges(persisted, acknowledgement)
          : persisted.some(
              (message) =>
                ordinaryUser(message) && !before.has(message.info?.id),
            );
        if (!acknowledged)
          await delay(25, undefined, { signal: dispatchSignal });
      }
      this.awaiting.delete(hosted.stateRoot);
      this.uncertain.delete(hosted.stateRoot);
      return response;
    } finally {
      this.admitting.delete(hosted.stateRoot);
    }
  }

  recover(
    hosted: HostedOpenCode,
    sessionId: string,
    messageId: string,
  ): Promise<void> {
    if (
      this.admitting.has(hosted.stateRoot) ||
      this.uncertain.has(hosted.stateRoot)
    )
      return Promise.reject(
        new Error("A user request has not been reconciled"),
      );
    const previous = this.pending.get(hosted.stateRoot);
    if (previous) return previous;
    const request = this.finish(hosted, sessionId, messageId).finally(() => {
      this.pending.delete(hosted.stateRoot);
    });
    this.pending.set(hosted.stateRoot, request);
    return request;
  }

  private async finish(
    hosted: HostedOpenCode,
    sessionId: string,
    messageId: string,
  ): Promise<void> {
    // Validate at the storage boundary, including callers outside the router.
    // Keep the existing filenames so persisted dispatch fences still apply.
    if (
      typeof sessionId !== "string" ||
      !/^ses_[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      typeof messageId !== "string" ||
      !/^msg_[A-Za-z0-9_-]{1,128}$/.test(messageId)
    )
      throw new Error("Invalid Assistant recovery identifiers");
    const file = join(
      hosted.stateRoot,
      `final-response-${sessionId}-${messageId}.json`,
    );
    const unlock = await new DurableFileLock(file).acquire();
    let dispatched = false;
    try {
      // Survives browser disconnects. Host revocation still cancels the request.
      const signal = AbortSignal.any([
        hosted.signal,
        AbortSignal.timeout(120_000),
      ]);
      const messages = await hosted.server.fetchJson<OpenCodeTurnMessage[]>(
        `/session/${sessionId}/message`,
        { signal },
      );
      const statuses = await hosted.server.fetchJson<
        Record<string, { type: string }>
      >("/session/status", { signal });
      if (
        openCodeTurn(messages, statuses[sessionId]?.type ?? "idle").missing !==
        messageId
      )
        throw new Error("Turn changed or no final response is missing");
      const session = await hosted.server.fetchJson<{ permission?: unknown[] }>(
        `/session/${sessionId}`,
        { signal },
      );
      // Native session permissions override agent permissions. Studio sessions
      // have none; fail closed if another client has changed that contract.
      if (session.permission?.length)
        throw new Error("Session permissions changed");
      const parentId = messages.find(
        (message) => message.info?.id === messageId,
      )?.info?.parentID;
      const parentIndex = messages.findIndex(
        (message) => message.info?.id === parentId,
      );
      const original = messages
        .slice(0, parentIndex + 1)
        .reverse()
        .find(
          (message) =>
            message.info?.role === "user" &&
            !message.parts.some(
              (part) =>
                part.type === "compaction" ||
                (part.synthetic && part.metadata?.compaction_continue === true),
            ),
        );
      const prompt = this.delivery.recoverPrompt
        ? await this.delivery.recoverPrompt(
            hosted,
            sessionId,
            original?.info?.system,
            signal,
          )
        : recoverAssistantPrompt(original?.info?.system);
      await this.current(hosted, signal);
      // Record BEFORE dispatch. An uncertain request is never retried on reload.
      await writeFile(file, "{}\n", { flag: "wx", mode: 0o600 });
      dispatched = true;
      signal.throwIfAborted();
      const response = await hosted.server.fetch(
        `/session/${sessionId}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...prompt,
            model: hosted.model,
            agent: turnRecoveryAgent,
            parts: [
              {
                type: "text",
                text: "The previous execution stopped unexpectedly. Continue the most recent user request before this recovery from the saved conversation and tool results. Complete any remaining requested work, then explain the actual results. Do not repeat completed actions, recap earlier completed turns, or expand the task. If all requested work is already done, provide the missing explanation. If you cannot complete the task, clearly explain what remains and why.",
              },
            ],
          }),
          signal,
        },
      );
      if (!response.ok) throw new Error("Final response failed");
      await response.arrayBuffer();
    } catch (error) {
      if (dispatched && !hosted.signal.aborted) {
        // Cancelling the HTTP waiter does not cancel OpenCode's native fiber.
        // Fence new prompts until abort is confirmed, even on transport failure.
        this.uncertain.add(hosted.stateRoot);
        try {
          const signal = AbortSignal.any([
            hosted.signal,
            AbortSignal.timeout(5000),
          ]);
          await hosted.server.fetchJson(`/session/${sessionId}/abort`, {
            method: "POST",
            signal,
          });
          const statuses = await hosted.server.fetchJson<
            Record<string, { type: string }>
          >("/session/status", { signal });
          if (!statuses[sessionId] || statuses[sessionId].type === "idle")
            this.uncertain.delete(hosted.stateRoot);
        } catch {
          /* Keep the fence until native state can be reconciled. */
        }
      }
      throw error;
    } finally {
      await unlock();
    }
  }
}
