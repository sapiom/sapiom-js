import type { OpenCodeTurnMessage } from "./opencode-turn.js";

// OpenCode 1.18.29 cannot read persisted json_schema format messages through
// its history API. Keep normal text and bind a result marker to each request.
export function openCodeCompletionPrompt() {
  const token = globalThis.crypto.randomUUID();
  return {
    system: `StudioAssistantResult/v2:${token}\nComplete the user's requested work before ending the turn, including any requested explanation. Finish necessary tool calls and examine their results before writing the final answer. A promise or plan to do the work is not completion. For conversational requests, provide the requested reply without unnecessary tool calls.\nBegin your final answer with exactly one of these bookkeeping lines, then write the answer on the following line, outside code blocks:\n<!-- studio-result:${token}:finished -->\n<!-- studio-result:${token}:failed -->\nUse finished only when the request is fulfilled. If you cannot finish, use failed and explain what remains and why. Do not include a result line in progress messages or alongside tool calls. Studio removes this line from the displayed answer; keep the rest of your answer in the format the user requested.`,
  };
}

export function openCodeCompletionTokens(
  messages: readonly OpenCodeTurnMessage[],
) {
  const tokens = new Map<string, string | undefined>();
  let current: string | undefined;
  for (const message of messages) {
    if (message.info?.role !== "user") continue;
    // Native overflow compaction may insert a user without its system field.
    if (
      !message.parts.some(
        (part) =>
          part.type === "compaction" ||
          (part.synthetic && part.metadata?.compaction_continue === true),
      )
    ) {
      current = /^StudioAssistantResult\/v[12]:([a-f0-9-]{36})\n/.exec(
        message.info.system ?? "",
      )?.[1];
    }
    tokens.set(message.info.id, current);
  }
  return tokens;
}

export function parseOpenCodeCompletion(text: string, token: string) {
  const suffix = "<!-- studio-result:" + token + ":";
  for (const status of ["finished", "failed"] as const) {
    const footer = suffix + status + " -->";
    const value = text.trim();
    if (value.startsWith(footer + "\n") || value.startsWith(footer + "\r\n")) {
      const answer = value.slice(footer.length).trimStart();
      if (answer && !answer.includes(suffix)) return { status, answer };
      continue;
    }
    // Preserve saved responses from the earlier footer contract.
    if (!value.endsWith("\n" + footer)) continue;
    const answer = value.slice(0, -footer.length).trimEnd();
    if (answer.trim() && !answer.includes(suffix) && !hasOpenFence(answer))
      return { status, answer };
  }
}

function hasOpenFence(text: string) {
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const [, marker, rest] = match;
    if (!fence) {
      if (marker![0] !== "`" || !rest!.includes("`")) fence = marker;
    } else if (
      marker![0] === fence[0] &&
      marker!.length >= fence.length &&
      !rest!.trim()
    ) {
      fence = undefined;
    }
  }
  return !!fence;
}

function visibleRange(
  text: string,
  token: string | undefined,
): [number, number] {
  if (!token) return [0, text.length];
  const prefix = "<!-- studio-result:" + token + ":";
  const leading = text.length - text.trimStart().length;
  if (text.slice(leading).startsWith(prefix)) {
    const end = text.indexOf("-->", leading + prefix.length);
    if (end === -1) return [text.length, text.length];
    const start = text.length - text.slice(end + 3).trimStart().length;
    const duplicate = text.indexOf(prefix, start);
    return [start, duplicate === -1 ? text.length : duplicate];
  }
  if (prefix.startsWith(text.slice(leading))) return [text.length, text.length];
  const index = text.indexOf(prefix);
  if (index !== -1) return [0, text.slice(0, index).trimEnd().length];
  for (let length = prefix.length - 1; length > 0; length--) {
    if (text.endsWith(prefix.slice(0, length)))
      return [0, text.slice(0, -length).trimEnd().length];
  }
  return [0, text.length];
}

/** Hide complete and partially streamed bookkeeping without changing other text. */
export function openCodeVisibleText(text: string, token: string | undefined) {
  return text.slice(...visibleRange(text, token));
}

/** Filter across part boundaries, including interrupted or unfinished answers. */
export function openCodeVisibleParts(
  parts: readonly { type: string; text?: string }[],
  token: string | undefined,
) {
  const text = parts
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
  const [visibleStart, visibleEnd] = visibleRange(text, token);
  let offset = 0;
  return parts.map((part) => {
    if (part.type !== "text") return undefined;
    const start = offset;
    offset += part.text?.length ?? 0;
    return text.slice(
      Math.max(start, visibleStart),
      Math.min(offset, visibleEnd),
    );
  });
}
