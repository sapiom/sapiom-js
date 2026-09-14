import type { HostedOpenCode } from "./opencode-host.js";
import type { AssistantRecordStore } from "./assistant-record-store.js";
import type {
  AssistantRecord,
  AssistantRecordBinding,
} from "../shared/assistant-record.js";
import {
  boundAssistantRecord,
  projectAssistantRecord,
} from "./assistant-record.js";

/** Preserve previously captured public content when native compaction omits it. */
export function reconcileAssistantRecord(
  previous: AssistantRecord | null,
  next: AssistantRecord,
): AssistantRecord {
  if (!previous) return next;
  if (JSON.stringify(previous.binding) !== JSON.stringify(next.binding))
    throw new Error("Assistant record binding changed");
  const turns = new Map(previous.turns.map((turn) => [turn.id, turn]));
  for (const turn of next.turns) {
    const old = turns.get(turn.id);
    const messages = new Map(
      old?.messages.map((message) => [message.id, message]),
    );
    for (const message of turn.messages) {
      const parts = new Map(
        messages.get(message.id)?.parts.map((part) => [part.id, part]),
      );
      for (const part of message.parts) parts.set(part.id, part);
      messages.set(message.id, { ...message, parts: [...parts.values()] });
    }
    turns.set(turn.id, {
      ...turn,
      acceptedContext: turn.acceptedContext ?? old?.acceptedContext ?? null,
      messages: [...messages.values()],
    });
  }
  const retained = [...turns.values()];
  return boundAssistantRecord({
    ...next,
    turns: retained,
    turnCount: Math.max(previous.turnCount, next.turnCount, retained.length),
    messageCount: Math.max(
      previous.messageCount,
      next.messageCount,
      retained.reduce((count, turn) => count + turn.messages.length, 0),
    ),
    limitations: [...new Set([...previous.limitations, ...next.limitations])],
  });
}

/** One host-owned reader, independent of browser mounts, with one pending invalidation. */
export class AssistantRecordCapture {
  private readonly lifetime = new AbortController();
  private pending = false;
  private running?: Promise<void>;
  private failed = false;
  readonly binding: AssistantRecordBinding;
  constructor(
    private readonly hosted: HostedOpenCode,
    conversationId: string,
    private readonly store: Pick<
      AssistantRecordStore,
      "read" | "write" | "reserve"
    >,
  ) {
    this.binding = {
      harnessSessionId: hosted.harnessSessionId,
      contextAuthorityScope: hosted.contextAuthorityScope,
      cwd: hosted.cwd,
      conversationId,
    };
    hosted.signal.addEventListener("abort", this.dispose, { once: true });
  }
  get unavailable(): boolean {
    return this.failed;
  }
  invalidate = (): void => {
    void this.checkpoint();
  };
  checkpoint(): Promise<void> {
    if (!this.live()) return Promise.resolve();
    this.pending = true;
    if (!this.running)
      this.running = this.capture().finally(() => {
        this.running = undefined;
        if (this.pending && this.live()) this.invalidate();
      });
    return this.running;
  }
  dispose = (): void => {
    this.pending = false;
    this.lifetime.abort();
    this.hosted.signal.removeEventListener("abort", this.dispose);
  };
  private live() {
    return (
      !this.lifetime.signal.aborted &&
      !this.hosted.signal.aborted &&
      this.hosted.isCurrent()
    );
  }
  private async capture(): Promise<void> {
    while (this.pending && this.live()) {
      this.pending = false;
      const signal = AbortSignal.any([
        this.lifetime.signal,
        this.hosted.signal,
        AbortSignal.timeout(3000),
      ]);
      try {
        const revision = await this.store.reserve(this.binding);
        signal.throwIfAborted();
        const response = await this.hosted.server.fetch(
          `/session/${this.binding.conversationId}/message`,
          { signal },
        );
        const native = await readBoundedHistory(response, signal);
        if (!this.live()) return;
        const next = projectAssistantRecord(native, this.binding, revision);
        const previous = await this.store.read(this.binding);
        const record = reconcileAssistantRecord(previous, next);
        signal.throwIfAborted();
        if (!this.live()) return;
        await this.store.write(record);
        this.failed = false;
      } catch {
        this.failed = true; // Retain the last successful checkpoint; never turn failure into absence.
      }
    }
  }
}

async function readBoundedHistory(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Assistant history unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024 * 1024)
        throw new Error("Assistant history exceeds capture limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
