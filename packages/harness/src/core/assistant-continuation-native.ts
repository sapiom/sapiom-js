import {
  assistantContentHash,
  encodeAssistantContext,
  parseStudioAssistantSystem,
} from "@sapiom/opencode";
import { isConversationId } from "../shared/assistant-state.js";
import { awaitAssistantInspection } from "./assistant-lifecycle.js";
import type {
  AssistantContinuationPatch,
  AssistantContinuationReceipt,
} from "./assistant-continuation-store.js";
import type { HostedOpenCode } from "./opencode-host.js";

/** Native mutations may have committed even when their HTTP response was lost. */
export class AssistantContinuationUnconfirmedError extends Error {
  readonly code = "CONTINUATION_UNCONFIRMED";
  constructor() {
    super(
      "Studio could not verify the prepared continuation. Retry this operation to check its saved result.",
    );
  }
}
const uncertain = () => new AssistantContinuationUnconfirmedError();
type Row = Record<string, unknown>;
const object = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw uncertain();
  return value as Row;
};
type Advance = (
  patch: AssistantContinuationPatch,
) => Promise<AssistantContinuationReceipt>;

/** Trusted no-reply protocol. Stable native IDs are mutable, so retries only read. */
export class AssistantContinuationNative {
  constructor(
    private readonly assertCurrent: (hosted: HostedOpenCode) => Promise<void>,
  ) {}

  private async current(hosted: HostedOpenCode, signal: AbortSignal) {
    signal = AbortSignal.any([signal, hosted.signal]);
    signal.throwIfAborted();
    hosted.signal.throwIfAborted();
    await awaitAssistantInspection(this.assertCurrent(hosted), signal);
    signal.throwIfAborted();
    hosted.signal.throwIfAborted();
  }

  private async request(
    hosted: HostedOpenCode,
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    signal = AbortSignal.any([signal, hosted.signal]);
    await this.current(hosted, signal);
    const pending = hosted.server
      .fetch(path, {
        signal,
        ...(body === undefined
          ? { method: "GET" }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      })
      .then((response) => {
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {});
          signal.throwIfAborted();
        }
        return response;
      });
    const response = await awaitAssistantInspection(pending, signal);
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw uncertain();
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await awaitAssistantInspection(
          reader.read(),
          signal,
        );
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024 * 1024) throw uncertain();
        chunks.push(value);
      }
      await this.current(hosted, signal);
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        throw uncertain();
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private marker(
    value: unknown,
    receipt: AssistantContinuationReceipt,
  ): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const row = value as Row;
    if (row.title !== receipt.nativeCreationMarker) return false;
    const metadata = row.metadata as Row | undefined;
    const continuation = metadata?.sapiomContinuation as Row | undefined;
    return continuation?.operationId === receipt.operationId;
  }

  async conversation(
    hosted: HostedOpenCode,
    input: AssistantContinuationReceipt,
    advance: Advance,
    signal: AbortSignal,
  ): Promise<string> {
    let receipt = input;
    if (
      hosted.harnessSessionId !== receipt.childStudioId ||
      !["allocated", "creating"].includes(receipt.phase)
    )
      throw uncertain();
    if (receipt.phase === "allocated") {
      await this.current(hosted, signal);
      receipt = await advance({ phase: "creating" });
      await this.current(hosted, signal);
      try {
        await this.request(hosted, "/session", signal, {
          title: receipt.nativeCreationMarker,
          metadata: {
            sapiomContinuation: { operationId: receipt.operationId },
          },
        });
      } catch {
        // Inspect even after a lost HTTP acknowledgement. Never send creation twice.
        await this.current(hosted, signal);
      }
    }
    const rows = await this.request(
      hosted,
      `/session?search=${encodeURIComponent(receipt.nativeCreationMarker)}&limit=100`,
      signal,
    );
    if (!Array.isArray(rows) || rows.length >= 100) throw uncertain();
    const matches = rows.filter((row) => this.marker(row, receipt));
    if (matches.length !== 1) throw uncertain();
    const match = object(matches[0]);
    if (!isConversationId(match.id) || match.id === hosted.harnessSessionId)
      throw uncertain();
    const saved = object(
      await this.request(hosted, `/session/${match.id}`, signal),
    );
    if (
      saved.id !== match.id ||
      saved.directory !== hosted.cwd ||
      !this.marker(saved, receipt)
    )
      throw uncertain();
    return match.id;
  }

  private child(
    hosted: HostedOpenCode,
    receipt: AssistantContinuationReceipt,
  ): string {
    const binding = receipt.childBinding;
    if (
      !binding ||
      binding.harnessSessionId !== hosted.harnessSessionId ||
      binding.harnessSessionId !== receipt.childStudioId ||
      !isConversationId(binding.conversationId) ||
      binding.cwd !== hosted.cwd ||
      binding.contextAuthorityScope !== hosted.contextAuthorityScope
    )
      throw uncertain();
    return binding.conversationId;
  }

  private acceptedSystem(
    hosted: HostedOpenCode,
    receipt: AssistantContinuationReceipt,
    system: string,
  ): void {
    try {
      const parsed = parseStudioAssistantSystem(system, {
        conversationId: this.child(hosted, receipt),
        authorityScope: hosted.contextAuthorityScope,
        attemptToken: receipt.attemptToken,
      });
      if (
        parsed.kind !== "accepted-v2" ||
        !receipt.acceptedRef ||
        receipt.acceptedRef.acceptanceId !== receipt.acceptanceId ||
        encodeAssistantContext(parsed.wire.accepted) !==
          encodeAssistantContext(receipt.acceptedRef) ||
        parsed.wire.context.session.id !== receipt.childStudioId ||
        parsed.wire.context.session.cwd !== hosted.cwd
      )
        throw uncertain();
      const sources = parsed.wire.stable.sourceManifest.sources.filter(
        (source) =>
          source.kind === "continuation" && source.status === "available",
      );
      if (
        sources.length !== 1 ||
        sources[0]!.contentHash !== receipt.brief.sha256
      )
        throw uncertain();
    } catch {
      throw uncertain();
    }
  }

  async seed(
    hosted: HostedOpenCode,
    input: AssistantContinuationReceipt,
    system: string,
    advance: Advance,
    signal: AbortSignal,
  ): Promise<void> {
    let receipt = input;
    const conversationId = this.child(hosted, receipt);
    this.acceptedSystem(hosted, receipt, system);
    if (
      !receipt.acceptedRef ||
      !system ||
      !["accepting", "seeding", "prepared"].includes(receipt.phase)
    )
      throw uncertain();
    if (receipt.phase === "accepting") {
      await this.current(hosted, signal);
      receipt = await advance({ phase: "seeding" });
      await this.current(hosted, signal);
      try {
        await this.request(
          hosted,
          `/session/${conversationId}/message`,
          signal,
          {
            messageID: receipt.seedMessageId,
            model: { ...hosted.model },
            agent: "build",
            noReply: true,
            system,
            parts: [
              {
                id: receipt.seedPartId,
                type: "text",
                text: receipt.brief.text,
                synthetic: true,
                ignored: false,
                metadata: {
                  sapiomContinuation: {
                    operationId: receipt.operationId,
                    briefHash: receipt.brief.sha256,
                  },
                },
              },
            ],
          },
        );
      } catch {
        await this.current(hosted, signal);
      }
    }
    await this.verifySeed(hosted, receipt, system, signal);
  }

  /** The exact proof used for prepared status and server-owned seed attestation. */
  async verifySeed(
    hosted: HostedOpenCode,
    receipt: AssistantContinuationReceipt,
    system: string,
    signal: AbortSignal,
  ): Promise<void> {
    const conversationId = this.child(hosted, receipt);
    this.acceptedSystem(hosted, receipt, system);
    const row = object(
      await this.request(
        hosted,
        `/session/${conversationId}/message/${receipt.seedMessageId}`,
        signal,
      ),
    );
    const info = object(row.info);
    if (
      info.id !== receipt.seedMessageId ||
      info.sessionID !== conversationId ||
      info.role !== "user" ||
      info.system !== system ||
      !Array.isArray(row.parts) ||
      row.parts.length !== 1
    )
      throw uncertain();
    const part = object(row.parts[0]);
    const marker = object(object(part.metadata).sapiomContinuation);
    if (
      part.id !== receipt.seedPartId ||
      part.messageID !== info.id ||
      part.sessionID !== conversationId ||
      part.type !== "text" ||
      part.synthetic !== true ||
      part.ignored !== false ||
      part.text !== receipt.brief.text ||
      assistantContentHash(part.text as string) !== receipt.brief.sha256 ||
      marker.operationId !== receipt.operationId ||
      marker.briefHash !== receipt.brief.sha256
    )
      throw uncertain();
    const history = await this.request(
      hosted,
      `/session/${conversationId}/message`,
      signal,
    );
    if (!Array.isArray(history) || history.length > 10_000) throw uncertain();
    const seeds = history.flatMap((message) => {
      const value = object(message);
      if (!Array.isArray(value.parts)) throw uncertain();
      return value.parts.flatMap((raw) => {
        const p = object(raw),
          metadata = p.metadata as Row | undefined;
        return (metadata?.sapiomContinuation as Row | undefined)
          ?.operationId === receipt.operationId
          ? [{ info: object(value.info), part: p }]
          : [];
      });
    });
    if (
      seeds.length !== 1 ||
      seeds[0]!.info.id !== receipt.seedMessageId ||
      seeds[0]!.info.sessionID !== conversationId ||
      seeds[0]!.info.role !== "user" ||
      seeds[0]!.info.system !== system ||
      encodeAssistantContext(seeds[0]!.part) !== encodeAssistantContext(part)
    )
      throw uncertain();
    await this.current(hosted, signal);
  }
}
