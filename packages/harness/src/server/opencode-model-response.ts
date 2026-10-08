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

/** Responses carries the native contract in instructions or trusted input roles. */
export function openCodeModelCompletionToken(request: Record<string, unknown>) {
  const texts: string[] = [];
  if (typeof request.instructions === "string")
    texts.push(request.instructions);
  for (const message of Array.isArray(request.input) ? request.input : []) {
    if (
      !message ||
      (message.type != null && message.type !== "message") ||
      !["system", "developer"].includes(message.role)
    )
      continue;
    if (typeof message.content === "string") texts.push(message.content);
    else if (Array.isArray(message.content))
      for (const part of message.content)
        if (part?.type === "input_text" && typeof part.text === "string")
          texts.push(part.text);
  }
  let token: string | undefined;
  for (const content of texts) {
    for (const match of content.matchAll(
      /(?:^|\n)StudioAssistantResult\/v2:([a-f0-9-]{36})\n/g,
    ))
      token = match[1];
  }
  return token;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
    ended = false;
  // A marker commits streaming, not completion: native terminal state still
  // rejects errors, absent answers, or simultaneous tools.
  const commitsText = (text: string) =>
    !!text.trim() &&
    (!completionToken || !!parseOpenCodeCompletion(text, completionToken));
  const canBufferPart = (part: unknown): boolean =>
    record(part) &&
    part.type === "output_text" &&
    typeof part.text === "string" &&
    !commitsText(part.text);
  const canBufferItem = (item: unknown): boolean => {
    if (!record(item)) return false;
    if (item.type === "reasoning")
      return (
        Array.isArray(item.summary) &&
        item.summary.every(
          (part) =>
            record(part) &&
            part.type === "summary_text" &&
            typeof part.text === "string",
        )
      );
    // Every tool kind (including future ones) commits the stream before native
    // can execute it. Refusals and unknown output also pass through unchanged.
    return (
      item.type === "message" &&
      item.role === "assistant" &&
      Array.isArray(item.content) &&
      item.content.every(canBufferPart)
    );
  };
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
        return replay(ended && !pending.trim());
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
        let value;
        try {
          value = JSON.parse(data);
        } catch {
          return replay();
        }
        if (!record(value) || value.error != null) return replay();
        switch (value.type) {
          case "response.created":
          case "response.in_progress":
          case "response.completed": {
            const result = value.response;
            if (
              !record(result) ||
              result.error != null ||
              result.incomplete_details != null ||
              !Array.isArray(result.output) ||
              !result.output.every(canBufferItem)
            )
              return replay();
            if (value.type === "response.completed") {
              if (result.status !== "completed") return replay();
              ended = true;
            } else if (result.status !== "in_progress") return replay();
            break;
          }
          case "response.output_item.added":
          case "response.output_item.done":
            if (!canBufferItem(value.item)) return replay();
            break;
          case "response.content_part.added":
          case "response.content_part.done":
            if (!canBufferPart(value.part)) return replay();
            break;
          case "response.output_text.delta":
            if (typeof value.delta !== "string") return replay();
            content += value.delta;
            if (commitsText(content)) return replay();
            break;
          case "response.output_text.done":
            if (typeof value.text !== "string" || commitsText(value.text))
              return replay();
            break;
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            if (typeof value.delta !== "string") return replay();
            break;
          case "response.reasoning_summary_text.done":
          case "response.reasoning_text.done":
            if (typeof value.text !== "string") return replay();
            break;
          case "response.reasoning_summary_part.added":
          case "response.reasoning_summary_part.done":
            if (
              !record(value.part) ||
              value.part.type !== "summary_text" ||
              typeof value.part.text !== "string"
            )
              return replay();
            break;
          default:
            return replay();
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw error;
  }
}
