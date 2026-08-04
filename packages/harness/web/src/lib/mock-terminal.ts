/**
 * Deterministic demo terminal for the static Pages build (VITE_MOCK=1).
 *
 * The real product binds xterm.js to a live PTY over /ws/terminal and the
 * actual `claude` / `codex` binary draws its own TUI. GitHub Pages has no
 * server, so mock mode replays a transcript styled EXACTLY like the real
 * Claude Code CLI — welcome box, ⏺ tool calls with ⎿ results, and the
 * bordered prompt box pinned at the bottom — so the demo looks like the
 * product, not a fake log. It never claims to be live: the status pill says
 * "Demo session" and submitted prompts get an honest notice.
 */
import type { Terminal as XTerm } from "@xterm/xterm";

const ESC = "\x1b[";
const dim = (s: string): string => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string): string => `${ESC}1m${s}${ESC}0m`;
const cyan = (s: string): string => `${ESC}36m${s}${ESC}0m`;
const green = (s: string): string => `${ESC}32m${s}${ESC}0m`;

interface ScriptLine {
  text: string;
  delayMs: number;
}

/** Box width: full terminal minus a 1-col right margin, floored for tiny panes. */
function boxWidth(term: XTerm): number {
  return Math.max(30, term.cols - 1);
}

/** Visible width of a string once its ANSI SGR sequences are stripped. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** The bordered prompt box + shortcut hint, exactly like the real CLI.
 *  The hint is truncated to one guaranteed visual line so the trailing
 *  relative cursor move (up 2, col 5 — inside the box after "> ") always
 *  lands on the input row, even at the bottom of a scrolled screen. */
function promptBox(term: XTerm): string {
  const w = boxWidth(term);
  const inner = w - 2;
  const hint = "  ? for shortcuts · demo, not a live coding agent".slice(0, w);
  return (
    dim("╭" + "─".repeat(inner) + "╮") +
    "\r\n" +
    dim("│") +
    " " +
    bold(">") +
    " ".repeat(Math.max(0, inner - 3)) +
    dim("│") +
    "\r\n" +
    dim("╰" + "─".repeat(inner) + "╯") +
    "\r\n" +
    dim(hint) +
    `${ESC}2A\r${ESC}4C`
  );
}

function transcript(): ScriptLine[] {
  return [
    // The tip now lives in the Sapiom masthead (TerminalBrand), so the scripted
    // transcript opens straight into the conversation.
    { text: bold("> ") + "Map the leasing agent and visualize it\r\n\r\n", delayMs: 700 },
    { text: green("⏺") + " I'll read the agent definition first.\r\n\r\n", delayMs: 800 },
    { text: green("⏺") + " " + bold("Read") + "(sapiom.json)\r\n", delayMs: 600 },
    { text: dim("  ⎿  Read 42 lines") + "\r\n\r\n", delayMs: 500 },
    {
      // Same workflow, same slugs, same counting rule as the canvas graph:
      // leasing = 4 typed steps + 2 exits. The chain is pre-broken so no
      // pane width splits a step name mid-word.
      text:
        green("⏺") +
        " Found agent " +
        bold("leasing") +
        ": 4 typed steps, 2 exits\r\n  " +
        cyan("intake → screen → credit-check → approve?") +
        "\r\n  " +
        cyan("↳ draft-lease / manual-review") +
        "\r\n\r\n",
      delayMs: 800,
    },
    { text: green("⏺") + " " + bold("Write") + "(.sapiom/canvas/renders/leasing.html)\r\n", delayMs: 700 },
    { text: dim("  ⎿  Wrote 118 lines") + "\r\n\r\n", delayMs: 500 },
    {
      // Pre-broken like the tip line: xterm wraps at the column boundary
      // with no regard for words, so authored copy supplies its own breaks.
      text:
        green("⏺") +
        " Done. The diagram is rendered. Press " +
        bold("Visualize") +
        "\r\n  in the Canvas pane to view it.\r\n\r\n",
      delayMs: 700,
    },
    // The prod run after Visualize — the CLI transcript matches the other
    // surfaces' end-state (the Steps tab shows the same run).
    { text: bold("> ") + "Run it on prod\r\n\r\n", delayMs: 800 },
    { text: green("⏺") + " " + bold("Bash") + "(sapiom agents run --target prod)\r\n", delayMs: 700 },
    { text: dim("  ⎿  Started execution exec-leasing-prod-001") + "\r\n\r\n", delayMs: 600 },
    {
      text:
        green("⏺") +
        " Run completed: 5 steps passed\r\n  " +
        cyan("intake · screen · credit-check · approve · draft-lease") +
        "\r\n\r\n",
      delayMs: 900,
    },
  ];
}

export interface MockTerminalHandle {
  dispose(): void;
}

export function attachMockTerminal(term: XTerm): MockTerminalHandle {
  let disposed = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const script = transcript();
  const schedule = (index: number): void => {
    if (disposed) return;
    if (index >= script.length) {
      term.write(promptBox(term));
      return;
    }
    timers.push(
      setTimeout(() => {
        if (!disposed) {
          term.write(script[index].text);
          schedule(index + 1);
        }
      }, script[index].delayMs),
    );
  };
  timers.push(
    setTimeout(() => {
      if (!disposed) {
        // The Sapiom masthead (TerminalBrand) now replaces the CLI welcome box,
        // so the demo terminal opens straight into the scripted conversation.
        schedule(0);
      }
    }, 200),
  );

  // Echo typed input inside the prompt box; on Enter, answer with the honest
  // demo notice (below the box) and redraw a fresh prompt box.
  let buffer = "";
  const input = term.onData((data) => {
    if (disposed) return;
    if (data === "\r") {
      const typed = buffer;
      buffer = "";
      // Cursor sits on the input row — drop below the hint line first.
      term.write(`${ESC}2B\r\n\r\n`);
      if (typed.trim().length > 0) {
        term.write(
          green("⏺") +
            dim(" This is a recorded demo. Prompts aren't sent to a coding agent here.") +
            "\r\n" +
            dim("  Run `npx @sapiom/agent-studio@latest`") +
            "\r\n" +
            dim("    locally to work with a real session.") +
            "\r\n\r\n",
        );
      }
      term.write(promptBox(term));
    } else if (data === "\x7f") {
      if (buffer.length > 0) {
        buffer = buffer.slice(0, -1);
        term.write("\b \b");
      }
    } else if (data >= " " || data === "\t") {
      buffer += data;
      term.write(data);
    }
  });

  return {
    dispose(): void {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      input.dispose();
    },
  };
}
