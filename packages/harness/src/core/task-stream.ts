/**
 * Parses the line-oriented JSON a background task's agent process writes to
 * stdout (`claude -p --output-format stream-json --verbose`) into the two
 * things TaskManager actually needs: compact human-readable progress lines
 * for the canvas pane's live activity view, and the final result event's
 * error state. Pure and defensive — a task's stdout is another program's
 * output format, so anything unrecognized degrades to "no update", never a
 * throw.
 *
 * Event shapes handled (everything else is ignored):
 * - {"type":"system","subtype":"init",...}            → "Agent started"
 * - {"type":"assistant","message":{"content":[...]}}  → one line per block:
 *     {"type":"tool_use","name":"Write","input":{...}} → "Write <path/hint>"
 *     {"type":"text","text":"..."}                     → truncated snippet
 * - {"type":"result","is_error":bool,"result":"..."}  → final result
 */

/** Keep progress lines short enough to render as single status rows. */
const MAX_LINE_CHARS = 120;

export interface TaskStreamUpdate {
  /** Zero or more new progress lines (an assistant message can carry several
   *  content blocks). */
  statusLines: string[];
  /** Present only for the final "result" event. */
  result?: { isError: boolean; text: string };
}

function truncate(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > MAX_LINE_CHARS ? `${flattened.slice(0, MAX_LINE_CHARS - 1)}…` : flattened;
}

/**
 * The one input field per tool that identifies what it's acting on — enough
 * for a "Write .sapiom/canvas/index.html"-style status line without dumping
 * whole tool inputs (a Write's `content` can be an entire HTML file).
 */
function toolInputHint(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "url", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

interface ContentBlock {
  type?: unknown;
  name?: unknown;
  input?: unknown;
  text?: unknown;
}

/**
 * Parses one stdout line. Returns null for anything that isn't a recognized
 * stream event (blank lines, non-JSON noise, event types we don't render).
 */
export function parseTaskStreamLine(line: string): TaskStreamUpdate | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as Record<string, unknown>;

  if (event.type === "system" && event.subtype === "init") {
    return { statusLines: ["Agent started"] };
  }

  if (event.type === "assistant") {
    const message = event.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) return null;
    const statusLines: string[] = [];
    for (const block of message.content as ContentBlock[]) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        const hint = toolInputHint(block.input);
        statusLines.push(truncate(hint ? `${block.name} ${hint}` : block.name));
      } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        statusLines.push(truncate(block.text));
      }
    }
    return statusLines.length > 0 ? { statusLines } : null;
  }

  if (event.type === "result") {
    return {
      statusLines: [],
      result: {
        isError: event.is_error === true,
        text: typeof event.result === "string" ? event.result : "",
      },
    };
  }

  return null;
}
