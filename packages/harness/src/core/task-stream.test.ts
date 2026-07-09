import { describe, expect, it } from "vitest";
import { parseTaskStreamLine } from "./task-stream.js";

describe("parseTaskStreamLine", () => {
  it("ignores blank lines and non-JSON noise", () => {
    expect(parseTaskStreamLine("")).toBeNull();
    expect(parseTaskStreamLine("   ")).toBeNull();
    expect(parseTaskStreamLine("not json at all")).toBeNull();
    expect(parseTaskStreamLine("42")).toBeNull();
  });

  it("turns the init event into an 'Agent started' line", () => {
    const update = parseTaskStreamLine(JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }));
    expect(update).toEqual({ statusLines: ["Agent started"] });
  });

  it("renders a tool_use block as 'Name <hint>' using the tool's identifying input field", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: ".sapiom/canvas/_template.html" } },
          { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        ],
      },
    });
    expect(parseTaskStreamLine(line)).toEqual({
      statusLines: ["Read .sapiom/canvas/_template.html", "Bash ls -la"],
    });
  });

  it("renders a bare tool_use with no recognizable input hint as just the tool name", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [] } }] },
    });
    expect(parseTaskStreamLine(line)).toEqual({ statusLines: ["TodoWrite"] });
  });

  it("truncates and flattens long/multiline text blocks into a single snippet line", () => {
    const text = `First line.\nSecond line. ${"x".repeat(300)}`;
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
    const update = parseTaskStreamLine(line);
    expect(update?.statusLines).toHaveLength(1);
    const snippet = update?.statusLines[0] ?? "";
    expect(snippet.startsWith("First line. Second line.")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(120);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).not.toContain("\n");
  });

  it("returns null for an assistant message with no renderable blocks", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "   " }] } });
    expect(parseTaskStreamLine(line)).toBeNull();
  });

  it("surfaces the final result event's error state and text", () => {
    const ok = parseTaskStreamLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." }));
    expect(ok).toEqual({ statusLines: [], result: { isError: false, text: "Done." } });

    const failed = parseTaskStreamLine(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "API error" }),
    );
    expect(failed).toEqual({ statusLines: [], result: { isError: true, text: "API error" } });
  });

  it("ignores event types it doesn't render (tool results, unknown types)", () => {
    expect(parseTaskStreamLine(JSON.stringify({ type: "user", message: { content: [] } }))).toBeNull();
    expect(parseTaskStreamLine(JSON.stringify({ type: "mystery" }))).toBeNull();
  });
});
