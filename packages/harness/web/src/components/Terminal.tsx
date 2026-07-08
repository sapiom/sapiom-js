/**
 * Terminal — xterm.js bound to a session's /ws/terminal WebSocket.
 *
 * Ports two non-obvious fixes from browser-terminal work elsewhere in the
 * ecosystem: an Extended Device Attributes (XDA, `CSI > q`) reply and an
 * OSC 52 clipboard handler. Without them, terminal-aware CLIs either fail to
 * detect a terminal at all, or render as if clipboard support doesn't exist.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { buildTerminalWsUrl } from "../lib/terminal-ws.js";

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

// Palette values below are copied (values only) from Sapiom's own dark-mode
// design tokens, so the embedded terminal reads as part of the app rather
// than a bare xterm.js default panel.
const PANEL_BACKGROUND = "#0E0E0E";
const TEXT_PRIMARY = "#FAFAFA";
const TEXT_MUTED = "#A1A1AA";
const BRAND_ACCENT = "#6BE195";
const BORDER_SUBTLE = "#2E2E2E";
const STATUS_SUCCESS = "#10B981";
const STATUS_WAITING = "#F59E0B";
const STATUS_ERROR = "#EF4444";
const MONO_FONT_STACK =
  '"SF Mono", Menlo, Monaco, Inconsolata, "Source Code Pro", Consolas, "Liberation Mono", "Ubuntu Mono", "Courier Prime", "JetBrains Mono", "Courier New", monospace';

const XTERM_THEME = {
  background: PANEL_BACKGROUND,
  foreground: TEXT_PRIMARY,
  cursor: BRAND_ACCENT,
  cursorAccent: PANEL_BACKGROUND,
  selectionBackground: "rgba(107, 225, 149, 0.25)",
  black: "#1A1A1A",
  red: "#f87171",
  green: BRAND_ACCENT,
  yellow: "#f59e0b",
  blue: "#3b82f6",
  magenta: "#a78bfa",
  cyan: "#22d3ee",
  white: TEXT_PRIMARY,
  brightBlack: "#404040",
  brightRed: "#ff9b96",
  brightGreen: "#8bd4a6",
  brightYellow: "#ffd966",
  brightBlue: "#60a5fa",
  brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

export const Terminal = ({ sessionId, token }: TerminalProps): JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
      fontFamily: MONO_FONT_STACK,
      theme: XTERM_THEME,
      scrollback: 10_000,
      allowProposedApi: true,
    });
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

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      ws?.close();
      term.dispose();
    };
  }, [sessionId, token]);

  const statusColor =
    status === "connected" ? STATUS_SUCCESS : status === "error" ? STATUS_ERROR : STATUS_WAITING;
  const statusLabel =
    status === "connected" ? "Connected" : status === "error" ? (errorMessage ?? "Error") : "Connecting…";

  return (
    // Stable hook for the surrounding app shell to lay out/border this panel —
    // internal theming (colors, font, padding, status pill) lives here.
    <div
      className="harness-terminal"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        background: PANEL_BACKGROUND,
        borderRadius: 8,
        border: `1px solid ${BORDER_SUBTLE}`,
        overflow: "hidden",
      }}
    >
      <div
        data-status={status}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
          padding: "6px 10px",
          borderBottom: `1px solid ${BORDER_SUBTLE}`,
          fontFamily: MONO_FONT_STACK,
          fontSize: 11,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: statusColor,
            boxShadow: status === "connecting" ? `0 0 0 3px ${statusColor}33` : "none",
            flexShrink: 0,
          }}
        />
        <span style={{ color: TEXT_MUTED }}>{statusLabel}</span>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, padding: 8 }} />
    </div>
  );
};
