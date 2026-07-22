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
import { buildTerminalWsUrl } from "../lib/terminal-ws.js";
import { getTheme, subscribeTheme, type Theme } from "../lib/theme.js";
import { isMockMode } from "../lib/api.js";
import { attachMockTerminal, type MockTerminalHandle } from "../lib/mock-terminal.js";

export interface TerminalProps {
  sessionId: string;
  /** Per-boot token baked into the SPA; required on the WS upgrade. */
  token: string;
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
// chrome — kept as constants per theme, same as a data-viz scale.
const DARK_ANSI: Partial<ITheme> = {
  black: "#1a1a1e",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#f59e0b",
  blue: "#3b82f6",
  magenta: "#9b8fc4",
  cyan: "#22d3ee",
  white: "#f3f3f5",
  brightBlack: "#404046",
  brightRed: "#ff9b96",
  brightGreen: "#86efac",
  brightYellow: "#ffd966",
  brightBlue: "#60a5fa",
  brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

const LIGHT_ANSI: Partial<ITheme> = {
  black: "#3a3a3e",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#b45309",
  blue: "#2563eb",
  magenta: "#7c3aed",
  cyan: "#0891b2",
  white: "#d4d4d8",
  brightBlack: "#6b6b75",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#f59e0b",
  brightBlue: "#3b82f6",
  brightMagenta: "#9b8fc4",
  brightCyan: "#22d3ee",
  brightWhite: "#ffffff",
};

/**
 * Screen theme from the app's CSS tokens: app background/ink for the
 * canvas, the brand accent for cursor + selection. Read at call
 * time so it always reflects the current [data-theme].
 */
function xtermThemeFor(theme: Theme): ITheme {
  const background = readToken("--bg", theme === "dark" ? "#0c0c0e" : "#fbfbfc");
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
      resizeObserver.disconnect();
      inputDisposable.dispose();
      mock?.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, token]);

  const statusLabel =
    status === "connected"
      ? isMockMode()
        ? "Demo session, scripted. No live agent."
        : "Connected"
      : status === "error"
        ? (errorMessage ?? "Error")
        : "Connecting…";

  return (
    // Full-bleed terminal block: a status subheader over the raw PTY screen.
    // All chrome styling is class + token based — see styles.css.
    <div className="harness-terminal">
      <div className="terminal-statusbar" data-status={status}>
        <span className="terminal-status-dot" aria-hidden="true" />
        <span className="terminal-status-label">{statusLabel}</span>
      </div>
      <div ref={containerRef} className="terminal-screen" />
    </div>
  );
};
