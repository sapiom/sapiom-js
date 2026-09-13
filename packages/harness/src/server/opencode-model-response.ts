import { parseOpenCodeCompletion } from "../shared/opencode-completion.js";

/** Retry a clean incomplete generation before OpenCode can execute any call. */
export async function fetchOpenCodeModelResponse(
  request: () => Promise<Response>,
  signal: AbortSignal,
  completionToken?: string,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const upstream = await request();
    const { response, empty } = await inspect(upstream, completionToken);
    if (!empty || attempt === 2) return response;
    await response.body?.cancel();
    console.warn("[harness] Retrying an incomplete Assistant model response", {
      attempt: attempt + 1,
      requestId: upstream.headers.get("x-sapiom-request-id"),
    });
  }
}

/** Native sends the current contract in system text, never user/tool history. */
export function openCodeModelCompletionToken(request: Record<string, unknown>) {
  if (!Array.isArray(request.messages)) return;
  let token: string | undefined;
  for (const message of request.messages) {
    if (!message || message.role !== "system") continue;
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(
                (part: { type?: string; text?: unknown }) =>
                  part?.type === "text" && typeof part.text === "string",
              )
              .map((part: { text: string }) => part.text)
              .join("\n")
          : "";
    for (const match of content.matchAll(
      /(?:^|\n)StudioAssistantResult\/v2:([a-f0-9-]{36})\n/g,
    ))
      token = match[1];
  }
  return token;
}

async function inspect(response: Response, completionToken?: string) {
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    return { response, empty: false };
  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "",
    content = "",
    size = 0,
    stopped = false,
    ended = false;
  const replay = (empty = false) => ({
    empty,
    response: new Response(
      new ReadableStream({
        start(controller) {
          for (const bytes of prefix) controller.enqueue(bytes);
        },
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              reader.releaseLock();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            reader.releaseLock();
            controller.error(error);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
          reader.releaseLock();
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    ),
  });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        try {
          pending += decoder.decode();
        } catch {
          return replay();
        }
        return replay(stopped && ended && !pending.trim());
      }
      prefix.push(next.value);
      size += next.value.byteLength;
      // Bound pre-output buffering; ambiguous/oversized responses pass through.
      if (size > 1024 * 1024) return replay();
      try {
        pending += decoder.decode(next.value, { stream: true });
      } catch {
        return replay();
      }
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const lines = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"));
        if (!lines.length) continue;
        const data = lines.map((line) => line.slice(5).trimStart()).join("\n");
        if (ended) return replay();
        if (data === "[DONE]") {
          ended = true;
          continue;
        }
        let value;
        try {
          value = JSON.parse(data);
        } catch {
          return replay();
        }
        if (
          !value ||
          value.error ||
          !Array.isArray(value.choices) ||
          value.choices.length > 1
        )
          return replay();
        for (const choice of value.choices) {
          if (!choice || typeof choice !== "object" || choice.index !== 0)
            return replay();
          const delta = choice.delta;
          if (!delta || typeof delta !== "object" || Array.isArray(delta))
            return replay();
          if (
            (delta.role != null && delta.role !== "assistant") ||
            [delta.reasoning_content, delta.reasoning].some(
              (value) => value != null && typeof value !== "string",
            ) ||
            (delta.reasoning_details != null &&
              !Array.isArray(delta.reasoning_details)) ||
            (delta.content != null && typeof delta.content !== "string") ||
            delta.tool_calls != null ||
            delta.function_call != null ||
            delta.refusal != null ||
            Object.keys(delta).some(
              (key) =>
                ![
                  "role",
                  "content",
                  "reasoning_content",
                  "reasoning",
                  "reasoning_details",
                ].includes(key),
            ) ||
            (choice.finish_reason != null && choice.finish_reason !== "stop")
          )
            return replay();
          content += delta.content ?? "";
          // A marker commits streaming, not completion: native terminal state
          // still rejects errors, absent answers, or simultaneous tools.
          // Any tool fragment above also commits the stream before execution.
          if (
            content.trim() &&
            (!completionToken ||
              parseOpenCodeCompletion(content, completionToken))
          )
            return replay();
          if (choice.finish_reason === "stop") stopped = true;
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw error;
  }
}
