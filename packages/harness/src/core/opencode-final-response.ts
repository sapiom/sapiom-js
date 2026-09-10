import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HostedOpenCode } from "./opencode-host.js";
import { DurableFileLock } from "./durable-file-lock.js";
import { openCodeCompletionPrompt } from "../shared/opencode-completion.js";
import {
  turnRecoveryAgent,
  openCodeTurn,
  type OpenCodeTurnMessage,
} from "../shared/opencode-turn.js";

/** One continuation from saved results; never resubmit the original prompt. */
export class OpenCodeFinalResponse {
  private pending = new Map<string, Promise<void>>();
  private admitting = new Set<string>();
  private uncertain = new Set<string>();

  isRunning(hosted: HostedOpenCode): boolean {
    return (
      this.pending.has(hosted.stateRoot) || this.admitting.has(hosted.stateRoot)
    );
  }

  async send(
    hosted: HostedOpenCode,
    sessionId: string,
    init: RequestInit,
  ): Promise<Response> {
    if (this.isRunning(hosted))
      throw new Error("Another request is being admitted");
    this.admitting.add(hosted.stateRoot);
    const signal = AbortSignal.any([
      hosted.signal,
      AbortSignal.timeout(30_000),
    ]);
    const history = () =>
      hosted.server.fetchJson<OpenCodeTurnMessage[]>(
        `/session/${sessionId}/message`,
        { signal },
      );
    try {
      if (this.uncertain.has(hosted.stateRoot)) {
        const statuses = await hosted.server.fetchJson<
          Record<string, { type: string }>
        >("/session/status", { signal });
        if (statuses[sessionId] && statuses[sessionId].type !== "idle")
          throw new Error("Previous request is still running");
      }
      const before = new Set(
        (await history()).map((message) => message.info?.id),
      );
      this.uncertain.add(hosted.stateRoot);
      const response = await hosted.server.fetch(
        `/session/${sessionId}/prompt_async`,
        init,
      );
      if (!response.ok) return response;
      // A native 204 means scheduled. Keep admission closed until the user
      // message is persisted, so recovery cannot overtake a queued prompt.
      while (
        !(await history()).some(
          ({ info }) => info?.role === "user" && !before.has(info.id),
        )
      )
        await delay(25, undefined, { signal });
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
      // Record BEFORE dispatch. An uncertain request is never retried on reload.
      await writeFile(file, "{}\n", { flag: "wx", mode: 0o600 });
      dispatched = true;
      const response = await hosted.server.fetch(
        `/session/${sessionId}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...openCodeCompletionPrompt(),
            agent: turnRecoveryAgent,
            parts: [
              {
                type: "text",
                text: "The previous execution stopped unexpectedly. Continue the original user request from the saved conversation and tool results. Complete any remaining requested work, then explain the actual results. Do not repeat completed actions or expand the task. If all requested work is already done, provide the missing explanation. If you cannot complete the task, clearly explain what remains and why.",
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
