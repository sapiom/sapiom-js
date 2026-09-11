import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostedOpenCode } from "./opencode-host.js";
import { DurableFileLock } from "./durable-file-lock.js";

export const isConversationId = (id: unknown): id is string =>
  typeof id === "string" && /^ses_[A-Za-z0-9_-]{1,128}$/.test(id);

/** One native conversation per Studio session; the host holds the owner lock. */
export class OpenCodeAssociations {
  private pending = new WeakMap<HostedOpenCode, Promise<string>>();

  ensure(hosted: HostedOpenCode): Promise<string> {
    const existing = this.pending.get(hosted);
    if (existing) return existing;
    const pending = this.load(hosted).catch((error) => {
      this.pending.delete(hosted);
      throw error;
    });
    this.pending.set(hosted, pending);
    return pending;
  }

  private async load(hosted: HostedOpenCode): Promise<string> {
    const file = join(hosted.stateRoot, "association.json");
    // Held through commit even if the runtime retires during filesystem I/O.
    // A replacement host must finish this transaction before reading a mapping.
    const unlock = await new DurableFileLock(file).acquire();
    try {
      hosted.signal.throwIfAborted();
      return await this.readOrCreate(hosted, file);
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
        throw new Error("Assistant conversation association is invalid");
      // Missing history is an error, never permission to silently replace it.
      const session = await hosted.server.fetchJson<{ id: string }>(
        `/session/${saved.conversationId}`,
        { signal },
      );
      if (session.id !== saved.conversationId)
        throw new Error("Assistant conversation is unavailable");
      return saved.conversationId;
    }
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
