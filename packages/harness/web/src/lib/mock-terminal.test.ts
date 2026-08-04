import { afterEach, describe, expect, it, vi } from "vitest";

import { attachMockTerminal } from "./mock-terminal";

const stripAnsi = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

describe("attachMockTerminal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels the recorded interaction as separate from a live coding agent", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let onData: ((data: string) => void) | undefined;
    const terminal = {
      cols: 80,
      write: (value: string): void => {
        writes.push(value);
      },
      onData: (listener: (data: string) => void) => {
        onData = listener;
        return { dispose: vi.fn() };
      },
    };

    const handle = attachMockTerminal(
      terminal as unknown as Parameters<typeof attachMockTerminal>[0],
    );
    onData?.("Map this agent");
    onData?.("\r");

    const rendered = stripAnsi(writes.join(""));
    expect(rendered).toContain(
      "? for shortcuts · demo, not a live coding agent",
    );
    expect(rendered).toContain(
      "This is a recorded demo. Prompts aren't sent to a coding agent here.",
    );
    expect(rendered).toContain("npx @sapiom/agent-studio@latest");
    expect(rendered).not.toContain("npx @sapiom/harness");
    expect(rendered).not.toContain("Prompts aren't sent to an agent here.");

    handle.dispose();
  });
});
