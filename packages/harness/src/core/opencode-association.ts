import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OpenCodeTransportError,
  type HostedOpenCode,
} from "./opencode-host.js";
import { openCodeTransportFailure } from "../shared/opencode-errors.js";
import { DurableFileLock } from "@sapiom/agent-map/node/durable-file-lock";

import { isConversationId } from "../shared/assistant-state.js";
export { isConversationId } from "../shared/assistant-state.js";

/** One native conversation per host key; the host holds the owner lock. */
export class OpenCodeAssociations {
  private pending = new WeakMap<HostedOpenCode, Promise<string>>();
  private resetting = new WeakMap<HostedOpenCode, Promise<string>>();

  ensure(hosted: HostedOpenCode): Promise<string> {
    const existing = this.pending.get(hosted);
    if (existing) return existing;
    const pending: Promise<string> = this.load(hosted).catch((error) => {
      if (this.pending.get(hosted) === pending) this.pending.delete(hosted);
      throw error;
    });
    this.pending.set(hosted, pending);
    return pending;
  }

  /**
   * Starts a new conversation and saves it in place of the current one.
   * Overlapping resets share one new conversation, so no caller is handed an
   * id that a second reset has already replaced.
   */
  reset(hosted: HostedOpenCode): Promise<string> {
    const running = this.resetting.get(hosted);
    if (running) return running;
    const previous = this.pending.get(hosted) ?? Promise.resolve("");
    const pending: Promise<string> = previous
      .catch(() => "")
      .then(() =>
        this.transaction(hosted, (file) =>
          this.create(
            hosted,
            file,
            AbortSignal.any([hosted.signal, AbortSignal.timeout(15000)]),
          ),
        ),
      )
      .catch((error) => {
        if (this.pending.get(hosted) === pending) this.pending.delete(hosted);
        throw error;
      });
    this.pending.set(hosted, pending);
    this.resetting.set(hosted, pending);
    void pending
      .finally(() => {
        if (this.resetting.get(hosted) === pending)
          this.resetting.delete(hosted);
      })
      .catch(() => {});
    return pending;
  }

  private load(hosted: HostedOpenCode): Promise<string> {
    return this.transaction(hosted, (file) => this.readOrCreate(hosted, file));
  }

  private async transaction(
    hosted: HostedOpenCode,
    run: (file: string) => Promise<string>,
  ): Promise<string> {
    const file = join(hosted.stateRoot, "association.json");
    // Held through commit even if the runtime retires during filesystem I/O.
    // A replacement host must finish this transaction before reading a mapping.
    const unlock = await new DurableFileLock(file).acquire();
    try {
      hosted.signal.throwIfAborted();
      return await run(file);
    } finally {
      await unlock();
    }
  }

  private async readOrCreate(
    hosted: HostedOpenCode,
    file: string,
  ): Promise<string> {
    const signal = AbortSignal.any([hosted.signal, AbortSignal.timeout(15000)]);
    let saved: { version?: unknown; conversationId?: unknown } | undefined;
    try {
      saved = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (saved !== undefined) {
      if (
        saved?.version !== 1 ||
        !isConversationId(saved.conversationId) ||
        saved.conversationId === hosted.harnessSessionId
      )
        throw new OpenCodeTransportError(
          openCodeTransportFailure("native_history_missing"),
        );
      // Missing history is an error, never permission to silently replace it.
      let response: Response;
      try {
        response = await hosted.server.fetch(
          `/session/${saved.conversationId}`,
          { signal },
        );
      } catch {
        if (signal.reason instanceof OpenCodeTransportError)
          throw signal.reason;
        throw new OpenCodeTransportError(
          openCodeTransportFailure("transport_unavailable"),
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new OpenCodeTransportError(
          openCodeTransportFailure(
            response.status === 404
              ? "native_history_missing"
              : "transport_unavailable",
          ),
        );
      }
      let session: { id?: unknown };
      try {
        session = (await response.json()) as { id?: unknown };
      } catch {
        throw new OpenCodeTransportError(
          openCodeTransportFailure("transport_unavailable"),
        );
      }
      if (session.id !== saved.conversationId)
        throw new OpenCodeTransportError(
          openCodeTransportFailure("transport_unavailable"),
        );
      return saved.conversationId;
    }
    return this.create(hosted, file, signal);
  }

  private async create(
    hosted: HostedOpenCode,
    file: string,
    signal: AbortSignal,
  ): Promise<string> {
    const session = await hosted.server.fetchJson<{ id: string }>("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    });
    if (!isConversationId(session.id) || session.id === hosted.harnessSessionId)
      throw new Error("Assistant returned an invalid conversation");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, conversationId: session.id }),
        { mode: 0o600, flag: "wx" },
      );
      hosted.signal.throwIfAborted();
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    return session.id;
  }
}
