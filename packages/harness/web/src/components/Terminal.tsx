/**
 * Terminal — xterm.js bound to a session's /ws/terminal WebSocket.
 *
 * How the real CLI UI renders here: the harness server spawns the actual
 * `claude` / `codex` binary inside a node-pty (TERM=xterm-256color) and
 * relays raw PTY bytes over the socket both ways (JSON {type:"resize"}
 * control frames from client to server). xterm.js renders those bytes
 * verbatim — the CLI draws its own real TUI; nothing is re-implemented.
 *
 * Ports two non-obvious fixes from browser-terminal work elsewhere in the
 * ecosystem: an Extended Device Attributes (XDA, `CSI > q`) reply and an
 * OSC 52 clipboard handler. Without them, terminal-aware CLIs either fail to
 * detect a terminal at all, or render as if clipboard support doesn't exist.
 *
 * Theming: panel chrome (statusbar, borders) is CSS class + token based —
 * see "Terminal panel" in styles.css. The xterm screen itself needs concrete
 * color values, so they're read from the design-system tokens at mount and
 * on theme change; only the 16-color ANSI ramp stays constant per theme
 * (terminal data colors, not chrome — see design-system/themes.md).
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getDesktopBridge } from "../lib/desktop.js";
import { dropPayload } from "../lib/terminal-drop.js";
import { buildTerminalWsUrl } from "../lib/terminal-ws.js";
import { getTheme, subscribeTheme, type Theme } from "../lib/theme.js";
import { isMockMode } from "../lib/api.js";
import { attachMockTerminal, type MockTerminalHandle } from "../lib/mock-terminal.js";

export interface TerminalProps {
  sessionId: string;
  /** Per-boot token baked into the SPA; required on the WS upgrade. */
  token: string;
  /** The session's working directory, shown in the masthead's dir fact. */
  cwd?: string | null;
}

type ConnectionStatus = "connecting" | "connected" | "error";

const MAX_RECONNECT_DELAY_MS = 15_000;
// 4001 = bad/missing token, 4004 = session not found or has no live pty —
// both are permanent for this WS instance; retrying won't help.
const PERMANENT_CLOSE_CODES = new Set([4001, 4004]);

const FALLBACK_MONO =
  '"Geist Mono", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

/** Resolve a design-system custom property to a concrete value for xterm. */
function readToken(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// ANSI 16-color ramps: terminal DATA colors (what CLIs paint with), not app
// chrome — kept as constants per theme, same as a data-viz scale. Brand-coherent
// and authoritative over Claude Code's colors: the harness pins Claude to its
// `dark-ansi`/`light-ansi` theme (see core/inject/claude-settings.ts), so what
// Claude calls "blue"/"green"/etc. is literally whatever these slots hold. Green
// is the Studio brand green; blue is a calmer, less-saturated tone; the rest are
// harmonized to read cleanly on --bg without any one hue shouting.
const DARK_ANSI: Partial<ITheme> = {
  black: "#1a1a1e",
  red: "#e88a84",
  green: "#6be195", // Studio brand green (dark)
  yellow: "#e6b96f",
  blue: "#6f9ae0", // calmer blue
  magenta: "#b7a6dd",
  cyan: "#74c8d4",
  white: "#e8e8ec",
  brightBlack: "#565661", // dim text — bumped from #404046 for legibility
  brightRed: "#f4a7a1",
  brightGreen: "#8ceab0", // brand green hover (dark)
  brightYellow: "#f2cf93",
  brightBlue: "#8fb5ea",
  brightMagenta: "#ccbdf0",
  brightCyan: "#97dce7",
  brightWhite: "#ffffff",
};

const LIGHT_ANSI: Partial<ITheme> = {
  black: "#3a3a3e",
  red: "#c0392b",
  green: "#167e3a", // Studio brand green (light)
  yellow: "#a86414",
  blue: "#4f7cc4", // calmer blue
  magenta: "#7a4fb0",
  cyan: "#0e7d94",
  // Mid grey, not near-white: near-white foreground is invisible on the light
  // --bg anyway, and this keeps dim text legible if a dark-base session's
  // `white` slot ends up mapped here after a mid-session theme toggle.
  white: "#a6a6ae",
  brightBlack: "#6b6b75", // dim text
  brightRed: "#d64a3d",
  brightGreen: "#1f9a4a", // brand green (brighter, light)
  brightYellow: "#c67d1a",
  brightBlue: "#6f9ae0",
  brightMagenta: "#9268c4",
  brightCyan: "#1596ad",
  brightWhite: "#ffffff",
};

/**
 * Screen theme from the app's CSS tokens: app background/ink for the
 * canvas, the brand accent for cursor + selection. Read at call
 * time so it always reflects the current [data-theme].
 */
function xtermThemeFor(theme: Theme): ITheme {
  // The shell block is the recessed surface (same as the rail), so the xterm
  // canvas paints --bg to match the session bar + masthead around it.
  const background = readToken("--bg", theme === "dark" ? "#0b0e13" : "#f8f9fa");
  const foreground = readToken("--ink", theme === "dark" ? "#f3f3f5" : "#16161a");
  // Fallbacks mirror the per-theme --brand values in styles.css.
  const brand = readToken("--brand", theme === "dark" ? "#6be195" : "#167e3a");
  return {
    ...(theme === "dark" ? DARK_ANSI : LIGHT_ANSI),
    background,
    foreground,
    cursor: brand,
    cursorAccent: background,
    // Brand at ~25% — hex alpha works because --brand is a hex token.
    selectionBackground: `${brand}40`,
  };
}

export const Terminal = ({ sessionId, token }: TerminalProps): JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Re-applies live on toggle — doesn't touch the pty connection, so this is
  // a separate effect from the one that opens the terminal/socket below.
  useEffect(
    () =>
      subscribeTheme((next: Theme) => {
        if (termRef.current) termRef.current.options.theme = xtermThemeFor(next);
      }),
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: readToken("--mono", FALLBACK_MONO),
      theme: xtermThemeFor(getTheme()),
      scrollback: 10_000,
      allowProposedApi: true,
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    // XDA reply: some CLIs query "CSI > q" to identify the terminal before
    // enabling terminal-dependent features. xterm.js doesn't answer by
    // default; respond as XTerm so those code paths activate.
    term.parser.registerCsiHandler({ prefix: ">", final: "q" }, () => {
      term.write("\x1bP>|XTerm(370)\x1b\\");
      return true;
    });

    // OSC 52 clipboard: base64-encoded clipboard writes arrive as OSC 52;
    // xterm.js doesn't act on them itself, so wire it to the browser clipboard.
    term.parser.registerOscHandler(52, (data) => {
      const parts = data.split(";");
      if (parts.length < 2) return false;
      const b64 = parts[parts.length - 1];
      try {
        const binary = atob(b64);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        void navigator.clipboard?.writeText(text).catch(() => {});
      } catch {
        // Ignore malformed OSC 52 payloads.
      }
      return true;
    });

    term.open(container);
    fitAddon.fit();
    // Geist Mono usually lands after mount; a fit computed with fallback
    // metrics leaves uneven right/bottom remainders. Refit on real metrics.
    void document.fonts?.ready.then(() => {
      if (!disposed) {
        fitAddon.fit();
        sendResize();
      }
    });

    const inputDisposable = term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    });

    const sendResize = (): void => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      sendResize();
    });
    resizeObserver.observe(container);

    // Drop-to-path, like a native emulator: a file dropped on the terminal
    // types its quoted path at the cursor (Claude/Codex then handle it — an
    // image path pastes as `[Image #1]`). Only the desktop bridge can resolve
    // a File to a real path; in a plain browser the drop resolves to nothing,
    // but default is still prevented — the browser's default for a file drop
    // is to navigate the whole SPA away to the file.
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent): void => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      const pathForFile = getDesktopBridge()?.pathForFile;
      if (!pathForFile) return;
      const payload = dropPayload(Array.from(files, (file) => pathForFile(file)));
      if (payload === null) return;
      // paste() honors bracketed-paste mode, so the CLI sees one paste event
      // (the same reason injected prompts are bracketed — see core/bracketed-paste).
      term.paste(payload);
      term.focus();
    };
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);

    function connect(): void {
      if (disposed) return;
      const socket = new WebSocket(buildTerminalWsUrl(sessionId, token));
      ws = socket;

      socket.onopen = () => {
        reconnectAttempt = 0;
        setStatus("connected");
        setErrorMessage(null);
        fitAddon.fit();
        sendResize();
      };

      socket.onmessage = (event) => {
        const data =
          typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
        term.write(data);
      };

      socket.onclose = (event) => {
        if (disposed) return;
        if (PERMANENT_CLOSE_CODES.has(event.code)) {
          setStatus("error");
          setErrorMessage(event.reason || `Connection refused (${event.code})`);
          return;
        }
        const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
        reconnectAttempt += 1;
        setStatus("connecting");
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    // Static Pages demo: no server exists, so never open a WebSocket —
    // play the deterministic scripted transcript instead (see mock-terminal).
    let mock: MockTerminalHandle | null = null;
    if (isMockMode()) {
      mock = attachMockTerminal(term);
      setStatus("connected");
    } else {
      connect();
    }

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      mock?.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, token]);

  return (
    // Full-bleed terminal block: the raw PTY screen, full-bleed.
    // All chrome styling is class + token based — see styles.css.
    <div className="harness-terminal">
      <div ref={containerRef} className="terminal-screen" />
    </div>
  );
};
