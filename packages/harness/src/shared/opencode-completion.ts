import type { OpenCodeTurnMessage } from "./opencode-turn.js";

// OpenCode 1.18.29 cannot read persisted json_schema format messages through
// its history API. Keep normal text and bind a result marker to the
// conversation (see openCodeConversationToken).
export function openCodeCompletionPrompt(
  options: { mapChat?: boolean; token?: string } = {},
) {
  const token = options.token ?? globalThis.crypto.randomUUID();
  // Only the project map chat has the handoff tool, no shell and no file
  // edits (design I4, I10, flow §4.7); a Studio session's Assistant does the
  // work itself.
  const mapChat = options.mapChat
    ? " This chat has no shell and cannot edit files, and tools outside the project are denied. Read and answer questions here. When the user asks to change anything (add or edit a step, an agent, a file or a setting, fix, build or create something), or the request needs a shell command, a denied tool or a long run, call the handoff tool with a short title and a self-contained prompt instead of doing the work here or trying another way. Then say you offered a session the user can start; a turn that ends in that offer is finished."
    : "";
  return {
    system: `StudioAssistantResult/v2:${token}\nComplete the user's requested work before ending the turn, including any requested explanation. Finish necessary tool calls and examine their results before writing the final answer. A promise or plan to do the work is not completion. For conversational requests, provide the requested reply without unnecessary tool calls.${mapChat}\nBegin your final answer with exactly one of these bookkeeping lines, then write the answer on the following line, outside code blocks:\n<!-- studio-result:${token}:finished -->\n<!-- studio-result:${token}:failed -->\nUse finished only when the request is fulfilled. If you cannot finish, use failed and explain what remains and why. Do not include a result line in progress messages or alongside tool calls. Studio removes this line from the displayed answer; keep the rest of your answer in the format the user requested.`,
  };
}

const systemToken = (system: string | undefined) =>
  /^StudioAssistantResult\/v[12]:([a-f0-9-]{36})\n/.exec(system ?? "")?.[1];

/**
 * The token for the next request in this conversation. Models copy the marker
 * from their own earlier answers, so a token minted per request turned those
 * answers into missing ones (SAP-3876). Reuse the latest token this server
 * minted that the model already echoes, else the conversation's first one; a
 * token the model made up is never adopted.
 */
export function openCodeConversationToken(
  messages: readonly OpenCodeTurnMessage[],
) {
  const minted = new Set<string>();
  let first: string | undefined;
  let echoed: string | undefined;
  for (const message of messages) {
    if (message.info?.role === "user") {
      const token = systemToken(message.info.system);
      if (token) minted.add(token);
      first ??= token;
    }
    if (message.info?.role !== "assistant") continue;
    const text = message.parts
      .map((part) =>
        part.type === "text" && !part.ignored && !part.synthetic
          ? (part.text ?? "")
          : "",
      )
      .join("");
    // Only a declaration counts; a marker quoted in the body is not an echo.
    for (const token of minted)
      if (parseOpenCodeCompletion(text, token)) echoed = token;
  }
  return echoed ?? first;
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
      current = systemToken(message.info.system);
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

const completionMarkerPrefix = "<!-- studio-result:";

/** Match UUID-and-status syntax, including a possible prefix only while streaming. */
function completionMarkerLength(
  text: string,
  index: number,
  streaming: boolean,
) {
  let end = index + completionMarkerPrefix.length;
  for (const character of "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx") {
    if (end === text.length) return streaming ? end - index : 0;
    if (character === "-" ? text[end] !== "-" : !/^[a-f0-9]$/i.test(text[end]!))
      return 0;
    end++;
  }
  for (const ending of [":finished -->", ":failed -->"]) {
    if (text.startsWith(ending, end)) return end + ending.length - index;
    if (streaming && ending.startsWith(text.slice(end)))
      return text.length - index;
  }
  return 0;
}

/** Preserve prose around complete markers and unfinished streamed candidates. */
function visibleRanges(
  text: string,
  token: string | undefined,
  streaming: boolean,
): [number, number][] {
  if (!token) return [[0, text.length]];
  // A model can emit the wrong turn ID. Hide its bookkeeping too; only
  // parseOpenCodeCompletion may confirm a result against the expected token.
  const prefix = completionMarkerPrefix;
  const ranges: [number, number][] = [];
  let start = 0;
  let searchFrom = 0;
  while (searchFrom <= text.length) {
    const index = text.indexOf(prefix, searchFrom);
    if (index === -1) {
      let end = text.length;
      if (streaming) {
        for (let length = prefix.length - 1; length > 0; length--) {
          if (text.slice(searchFrom).endsWith(prefix.slice(0, length))) {
            end -= length;
            break;
          }
        }
      }
      ranges.push([start, end]);
      break;
    }
    const length = completionMarkerLength(text, index, streaming);
    if (!length) {
      searchFrom = index + prefix.length;
      continue;
    }
    ranges.push([start, index]);
    start = index + length;
    searchFrom = start;
  }
  // Trim the space left by a leading/footer marker, but retain text on both
  // sides of markers in the middle of a merged tool-progress/final response.
  while (ranges.length && !text.slice(...ranges[0]!).trim()) ranges.shift();
  const first = ranges[0];
  if (first && first[0] > 0) {
    const value = text.slice(...first);
    first[0] += value.length - value.trimStart().length;
  }
  while (ranges.length && !text.slice(...ranges.at(-1)!).trim()) ranges.pop();
  const last = ranges.at(-1);
  if (last && last[1] < text.length) {
    const value = text.slice(...last);
    last[1] -= value.length - value.trimEnd().length;
  }
  return ranges;
}

/** Hide markers; with streaming enabled, also withhold still-valid partial candidates. */
export function openCodeVisibleText(
  text: string,
  token: string | undefined,
  streaming = false,
) {
  return visibleRanges(text, token, streaming)
    .map((range) => text.slice(...range))
    .join("");
}

/** Filter across part boundaries; settled responses retain incomplete marker syntax. */
export function openCodeVisibleParts(
  parts: readonly { type: string; text?: string }[],
  token: string | undefined,
  streaming = false,
) {
  const text = parts
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
  const ranges = visibleRanges(text, token, streaming);
  let offset = 0;
  return parts.map((part) => {
    if (part.type !== "text") return undefined;
    const start = offset;
    offset += part.text?.length ?? 0;
    return ranges
      .map(([visibleStart, visibleEnd]) =>
        text.slice(Math.max(start, visibleStart), Math.min(offset, visibleEnd)),
      )
      .join("");
  });
}
