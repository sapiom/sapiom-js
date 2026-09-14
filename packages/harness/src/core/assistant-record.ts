import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  parseStudioAssistantSystem,
  validateAcceptedContextRef,
  type AcceptedContextRef,
} from "@sapiom/opencode";
import type {
  AssistantRecord,
  AssistantRecordBinding,
  AssistantRecordLimitation,
  AssistantRecordMessage,
  AssistantRecordPart,
} from "../shared/assistant-record.js";
import {
  openCodeCompletionTokens,
  openCodeVisibleParts,
} from "../shared/opencode-completion.js";
import {
  openCodeTurn,
  type OpenCodeTurnMessage,
} from "../shared/opencode-turn.js";

export const ASSISTANT_RECORD_MAX_BYTES = 64 * 1024;
export const ASSISTANT_RECORD_TEXT_CHARS = 4000;
export const ASSISTANT_RECORD_TOOL_CHARS = 512;
const maxNativeBytes = 16 * 1024 * 1024;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const timestamp = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bindingSchema = z
  .object({
    harnessSessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    contextAuthorityScope: z.string().regex(/^[a-f0-9]{64}$/),
    conversationId: z.string().regex(/^ses_[A-Za-z0-9_-]{1,128}$/),
    cwd: z
      .string()
      .max(4096)
      .refine((value) => isAbsolute(value) && !value.includes("\0")),
  })
  .strict()
  .refine((value) => value.conversationId !== value.harnessSessionId);
const acceptedRef = z.custom<AcceptedContextRef>((value) => {
  try {
    validateAcceptedContextRef(value);
    return true;
  } catch {
    return false;
  }
});
const partSchema = z.discriminatedUnion("type", [
  z
    .object({
      id,
      type: z.literal("text"),
      text: z.string().max(4000),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal("tool"),
      callId: id,
      name: z.string().min(1).max(256),
      status: z.enum(["pending", "running", "completed", "error"]),
      input: z.string().max(512),
      output: z.string().max(512).nullable(),
      error: z.string().max(512).nullable(),
      startedAt: timestamp.nullable(),
      completedAt: timestamp.nullable(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal("file"),
      name: z.string().max(256).nullable(),
      mime: z.string().max(256),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal("omitted"),
      nativeType: z.string().min(1).max(128),
    })
    .strict(),
]);
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    binding: bindingSchema,
    revision: count.positive(),
    capturedAt: z.string().datetime(),
    reconstructed: z.literal(true),
    turns: z
      .array(
        z
          .object({
            id,
            incomplete: z.boolean(),
            acceptedContext: acceptedRef.nullable(),
            messages: z
              .array(
                z
                  .object({
                    id,
                    role: z.enum(["user", "assistant"]),
                    parentId: id.nullable(),
                    createdAt: timestamp,
                    completedAt: timestamp.nullable(),
                    parts: z.array(partSchema).max(4096),
                  })
                  .strict(),
              )
              .min(1)
              .max(4096),
          })
          .strict(),
      )
      .max(4096),
    turnCount: count,
    messageCount: count,
    limitations: z
      .array(
        z.enum([
          "private-parts-omitted",
          "unknown-parts",
          "attachment-content-omitted",
          "accepted-context-unavailable",
          "field-truncation",
          "dropped-early-turns",
          "dropped-message-content",
        ]),
      )
      .max(7),
  })
  .strict();

export class AssistantRecordError extends Error {
  constructor(
    readonly code: "invalid_history" | "corrupt_record" | "record_unavailable",
  ) {
    super(`Assistant record ${code.replace(/_/g, " ")}`);
  }
}
const check: (value: unknown) => asserts value = (value) => {
  if (!value) throw new AssistantRecordError("invalid_history");
};
const object = (value: unknown): Record<string, unknown> => {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
export function validateAssistantRecordBinding(
  value: unknown,
): AssistantRecordBinding {
  try {
    return bindingSchema.parse(value);
  } catch {
    throw new AssistantRecordError("invalid_history");
  }
}
export function validateAssistantRecord(
  value: unknown,
  expected?: AssistantRecordBinding,
): AssistantRecord {
  try {
    check(
      Buffer.byteLength(JSON.stringify(value)) <= ASSISTANT_RECORD_MAX_BYTES,
    );
    const record = recordSchema.parse(value);
    if (expected)
      check(
        Object.entries(validateAssistantRecordBinding(expected)).every(
          ([key, v]) =>
            record.binding[key as keyof AssistantRecordBinding] === v,
        ),
      );
    const messages = new Set<string>(),
      parts = new Set<string>();
    for (const turn of record.turns) {
      const ref = turn.acceptedContext;
      if (ref)
        check(
          ref.authorityScope === record.binding.contextAuthorityScope &&
            ref.conversationId === record.binding.conversationId,
        );
      check(
        turn.messages[0]!.id === turn.id && turn.messages[0]!.role === "user",
      );
      for (const message of turn.messages) {
        check(!messages.has(message.id));
        messages.add(message.id);
        check(
          message.role === "user"
            ? message.id === turn.id && message.parentId === null
            : message.parentId === turn.id,
        );
        for (const part of message.parts) {
          check(!parts.has(part.id));
          parts.add(part.id);
        }
      }
    }
    check(
      record.turnCount >= record.turns.length &&
        record.messageCount >= messages.size,
    );
    return record;
  } catch {
    throw new AssistantRecordError("corrupt_record");
  }
}

/** Only the public native history API is input; private instructions/reasoning are never copied. */
export function projectAssistantRecord(
  nativeMessages: unknown,
  binding: AssistantRecordBinding,
  revision: number,
  capturedAt = new Date().toISOString(),
): AssistantRecord {
  try {
    binding = validateAssistantRecordBinding(binding);
    check(Array.isArray(nativeMessages) && nativeMessages.length <= 10000);
    check(Buffer.byteLength(JSON.stringify(nativeMessages)) <= maxNativeBytes);
    const limitations = new Set<AssistantRecordLimitation>();
    const clip = (value: unknown, cap: number): string => {
      check(typeof value === "string");
      if (value.length <= cap) return value;
      limitations.add("field-truncation");
      return value.slice(0, cap).replace(/[\uD800-\uDBFF]$/, "");
    };
    const seen = new Set<string>(),
      partIds = new Set<string>();
    const native = nativeMessages
      .map((value) => {
        const envelope = object(value),
          info = object(envelope.info),
          time = object(info.time);
        id.parse(info.id);
        check(!seen.has(info.id as string));
        seen.add(info.id as string);
        check(
          info.sessionID === binding.conversationId &&
            ["user", "assistant"].includes(info.role as string),
        );
        timestamp.parse(time.created);
        if (time.completed !== undefined) timestamp.parse(time.completed);
        if (info.role === "assistant") {
          id.parse(info.parentID);
          if (info.path) check(object(info.path).cwd === binding.cwd);
        }
        check(Array.isArray(envelope.parts) && envelope.parts.length <= 10000);
        for (const value of envelope.parts) {
          const part = object(value);
          id.parse(part.id);
          check(!partIds.has(part.id as string));
          partIds.add(part.id as string);
          check(
            part.sessionID === binding.conversationId &&
              part.messageID === info.id,
          );
          z.string().min(1).max(128).parse(part.type);
        }
        return { info, parts: envelope.parts.map(object) };
      })
      .sort(
        (a, b) =>
          Number(object(a.info.time).created) -
          Number(object(b.info.time).created),
      );
    const messages = native as unknown as OpenCodeTurnMessage[];
    const tokens = openCodeCompletionTokens(messages);
    const turns = new Map<string, AssistantRecord["turns"][number]>();
    const nativeTurns = new Map<string, OpenCodeTurnMessage[]>();
    for (const { info } of native) {
      if (info.role !== "user") continue;
      let acceptedContext: AcceptedContextRef | null = null;
      let parsed: ReturnType<typeof parseStudioAssistantSystem> | undefined;
      try {
        parsed = parseStudioAssistantSystem(info.system);
      } catch {
        /* Preserve a readable record when execution context is damaged. */
      }
      if (parsed?.kind === "accepted-v2") {
        const { accepted, context } = parsed.wire;
        check(
          accepted.authorityScope === binding.contextAuthorityScope &&
            accepted.conversationId === binding.conversationId,
        );
        check(
          context.session.id === binding.harnessSessionId &&
            context.session.cwd === binding.cwd,
        );
        acceptedContext = { ...accepted };
      } else limitations.add("accepted-context-unavailable");
      turns.set(info.id as string, {
        id: info.id as string,
        messages: [],
        incomplete: true,
        acceptedContext,
      });
    }
    for (const message of native) {
      const { info } = message,
        time = object(info.time);
      const turnId = (info.role === "user" ? info.id : info.parentID) as string;
      const turn = turns.get(turnId);
      check(turn);
      const grouped = nativeTurns.get(turnId) ?? [];
      grouped.push(message as unknown as OpenCodeTurnMessage);
      nativeTurns.set(turnId, grouped);
      const publicParts = message.parts.filter((part) => {
        if (part.synthetic || part.ignored || part.type === "reasoning") {
          limitations.add("private-parts-omitted");
          return false;
        }
        return true;
      });
      const visible = openCodeVisibleParts(
        publicParts as { type: string; text?: string }[],
        info.role === "assistant" ? tokens.get(turnId) : undefined,
        !time.completed,
      );
      const parts: AssistantRecordPart[] = publicParts.map((part, index) => {
        const partId = part.id as string;
        if (part.type === "text") {
          check(typeof part.text === "string");
          const text = visible[index]!;
          return {
            id: partId,
            type: "text",
            text: clip(text, ASSISTANT_RECORD_TEXT_CHARS),
            truncated: text.length > ASSISTANT_RECORD_TEXT_CHARS,
          };
        }
        if (part.type === "tool") {
          const state = object(part.state),
            input = JSON.stringify(object(state.input));
          const status = z
            .enum(["pending", "running", "completed", "error"])
            .parse(state.status);
          id.parse(part.callID);
          const name = z.string().min(1).max(256).parse(part.tool);
          const output =
            status === "completed" ? z.string().parse(state.output) : null;
          const error =
            status === "error" ? z.string().parse(state.error) : null;
          const toolTime = status === "pending" ? null : object(state.time);
          if (state.attachments) limitations.add("attachment-content-omitted");
          return {
            id: partId,
            type: "tool",
            callId: part.callID as string,
            name,
            status,
            input: clip(input, ASSISTANT_RECORD_TOOL_CHARS),
            output:
              output === null
                ? null
                : clip(output, ASSISTANT_RECORD_TOOL_CHARS),
            error:
              error === null ? null : clip(error, ASSISTANT_RECORD_TOOL_CHARS),
            startedAt: toolTime ? timestamp.parse(toolTime.start) : null,
            completedAt: ["completed", "error"].includes(status)
              ? timestamp.parse(toolTime!.end)
              : null,
            truncated: [input, output, error].some(
              (value) =>
                value !== null && value.length > ASSISTANT_RECORD_TOOL_CHARS,
            ),
          };
        }
        if (part.type === "file") {
          limitations.add("attachment-content-omitted");
          return {
            id: partId,
            type: "file",
            name: part.filename === undefined ? null : clip(part.filename, 256),
            mime: clip(part.mime, 256),
          };
        }
        if (!["step-start", "step-finish"].includes(part.type as string))
          limitations.add("unknown-parts");
        return { id: partId, type: "omitted", nativeType: part.type as string };
      });
      const projected: AssistantRecordMessage = {
        id: info.id as string,
        role: info.role as "user" | "assistant",
        parentId: info.role === "user" ? null : turnId,
        createdAt: time.created as number,
        completedAt: (time.completed as number | undefined) ?? null,
        parts,
      };
      // Native timestamps have millisecond precision; the parent need not sort first.
      if (info.role === "user") turn.messages.unshift(projected);
      else turn.messages.push(projected);
    }
    for (const turn of turns.values()) {
      check(turn.messages[0]?.role === "user");
      turn.incomplete =
        openCodeTurn(nativeTurns.get(turn.id)!, "idle").status !== "finished";
    }
    return boundAssistantRecord({
      schemaVersion: 1,
      binding,
      revision,
      capturedAt,
      reconstructed: true,
      turns: [...turns.values()],
      turnCount: turns.size,
      messageCount: native.length,
      limitations: [...limitations],
    });
  } catch {
    throw new AssistantRecordError("invalid_history");
  }
}

/** Bound already-projected content after capture reconciliation; detach before compaction. */
export function boundAssistantRecord(value: AssistantRecord): AssistantRecord {
  const record = JSON.parse(JSON.stringify(value)) as AssistantRecord;
  const limitations = new Set(record.limitations);
  const bytes = () => {
    record.limitations = [...limitations];
    return Buffer.byteLength(JSON.stringify(record));
  };
  let size = bytes();
  if (size > ASSISTANT_RECORD_MAX_BYTES && record.turns.length > 1) {
    limitations.add("dropped-early-turns");
    size = bytes();
    let removed = 0;
    while (
      size > ASSISTANT_RECORD_MAX_BYTES &&
      record.turns.length - removed > 1
    ) {
      size -= Buffer.byteLength(JSON.stringify(record.turns[removed++])) + 1;
    }
    record.turns = record.turns.slice(removed);
  }
  // Even one pathological tool-heavy turn must fit. Keep its prompt and newest message identities.
  if (size > ASSISTANT_RECORD_MAX_BYTES) {
    limitations.add("dropped-message-content");
    size = bytes();
  }
  while (size > ASSISTANT_RECORD_MAX_BYTES) {
    const turn = record.turns[0]!;
    if (turn.messages.length > 2) {
      size -=
        Buffer.byteLength(JSON.stringify(turn.messages.splice(1, 1)[0])) + 1;
    } else {
      const largest = [...turn.messages].sort(
        (a, b) => b.parts.length - a.parts.length,
      )[0]!;
      check(largest.parts.length > 0);
      const removed = largest.parts.shift();
      size -=
        Buffer.byteLength(JSON.stringify(removed)) +
        (largest.parts.length ? 1 : 0);
    }
  }
  return validateAssistantRecord(record);
}
