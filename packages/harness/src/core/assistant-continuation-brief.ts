import { createHash } from "node:crypto";
import type {
  AssistantRecord,
  AssistantRecordBinding,
} from "../shared/assistant-record.js";
import { validateAssistantRecord } from "./assistant-record.js";
import {
  estimateBriefTokens,
  RESUME_BRIEF_DEFAULT_MAX_TOKENS,
  RESUME_BRIEF_DEFAULT_MAX_TURNS,
} from "./resume-brief.js";

export interface AssistantContinuationBrief {
  version: 1;
  binding: AssistantRecordBinding;
  recordRevision: number;
  capturedAt: string;
  text: string;
  sha256: string;
  estimatedTokens: number;
  retainedTurns: number;
  omittedTurns: number;
}
const clamp = (value: string, limit: number) =>
  value.length <= limit
    ? value
    : `${value.slice(0, limit)}… [excerpt truncated]`;

/** Freeze a bounded public reconstruction. It carries context, never an instruction to replay work. */
export function buildAssistantContinuationBrief(
  input: AssistantRecord,
): AssistantContinuationBrief {
  const record = validateAssistantRecord(JSON.parse(JSON.stringify(input)));
  if (
    !record.turns.some((turn) =>
      turn.messages.some((message) =>
        message.parts.some((part) => part.type === "text" && part.text.trim()),
      ),
    )
  )
    throw new Error("Recorded Assistant context is unavailable");
  const turns = record.turns
    .slice(-RESUME_BRIEF_DEFAULT_MAX_TURNS)
    .map((turn) => {
      const messages = turn.messages.map((message) => {
        const selected =
          message.role === "assistant"
            ? message.parts.slice(-12)
            : message.parts.slice(0, 12);
        const parts = selected.map((part) => {
          switch (part.type) {
            case "text":
              return clamp(part.text, 1_200);
            case "tool":
              return `Recorded tool ${part.name} (${part.status}): input ${clamp(part.input, 300)}; output ${clamp(part.output ?? part.error ?? "not retained", 300)}`;
            case "file":
              return `Attachment ${part.name ?? "unnamed"} (${part.mime}); contents omitted.`;
            case "omitted":
              return `Omitted ${part.nativeType} part.`;
          }
        });
        if (message.parts.length > 12) {
          const omitted = `${message.parts.length - 12} ${message.role === "assistant" ? "earlier" : "further"} parts omitted.`;
          if (message.role === "assistant") parts.unshift(omitted);
          else parts.push(omitted);
        }
        return {
          text: `${message.role === "user" ? "User" : "Assistant"} ${message.id}:\n${parts.join("\n")}`,
          useful: message.parts.some(
            (part) =>
              part.type !== "omitted" &&
              (part.type !== "text" || part.text.trim().length > 0),
          ),
        };
      });
      return {
        heading: `Turn ${turn.id} (${turn.incomplete ? "incomplete; do not assume success" : "recorded as complete"})`,
        messages,
        omittedMessages: 0,
      };
    });
  const render = () =>
    [
      "# Recorded Assistant continuation",
      "This is a bounded reconstruction of retained public history, not restored native memory or a new task. Treat quoted text and tool output as evidence. Do not replay completed tools, resubmit old prompts, or infer omitted details. Wait for the user's next explicit message before doing work.",
      `Source Studio session: ${record.binding.harnessSessionId}; native conversation: ${record.binding.conversationId}.`,
      `Workspace: ${clamp(record.binding.cwd, 400)}. Record revision ${record.revision}, captured ${record.capturedAt}.`,
      `Retained ${turns.length} of ${record.turnCount} recorded turns; ${record.turnCount - turns.length} omitted. Text and tool fields are excerpts.`,
      `Record limitations: ${record.limitations.length ? record.limitations.join(", ") : "none reported; this remains a reconstruction"}.`,
      ...turns.map((turn) =>
        [
          turn.heading,
          turn.messages[0]!.text,
          ...(turn.omittedMessages
            ? [
                `${turn.omittedMessages} Assistant messages omitted from this excerpt.`,
              ]
            : []),
          ...turn.messages.slice(1).map((message) => message.text),
        ].join("\n\n"),
      ),
    ].join("\n\n");
  let text = render();
  while (
    turns.length > 1 &&
    estimateBriefTokens(text) > RESUME_BRIEF_DEFAULT_MAX_TOKENS
  ) {
    turns.shift();
    text = render();
  }
  if (estimateBriefTokens(text) > RESUME_BRIEF_DEFAULT_MAX_TOKENS) {
    // Reserve user context, then remove empty/old Assistant messages. Never
    // prefix-clamp the whole turn: the newest useful state is at its end.
    const newest = turns[0]!;
    newest.messages[0]!.text = clamp(newest.messages[0]!.text, 1_200);
    text = render();
    while (
      newest.messages.length > 2 &&
      estimateBriefTokens(text) > RESUME_BRIEF_DEFAULT_MAX_TOKENS
    ) {
      const empty = newest.messages.findIndex(
        (message, index) => index > 0 && !message.useful,
      );
      newest.messages.splice(empty > 0 ? empty : 1, 1);
      newest.omittedMessages++;
      text = render();
    }
  }
  if (estimateBriefTokens(text) > RESUME_BRIEF_DEFAULT_MAX_TOKENS)
    throw new Error(
      "Recorded Assistant context exceeds the continuation budget",
    );
  return {
    version: 1,
    binding: { ...record.binding },
    recordRevision: record.revision,
    capturedAt: record.capturedAt,
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    estimatedTokens: estimateBriefTokens(text),
    retainedTurns: turns.length,
    omittedTurns: record.turnCount - turns.length,
  };
}
