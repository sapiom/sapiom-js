/**
 * Terminal — xterm.js bound to a session's /ws/terminal WebSocket.
 *
 * Ports two non-obvious fixes from browser-terminal work elsewhere in the
 * ecosystem: an Extended Device Attributes (XDA, `CSI > q`) reply and an
 * OSC 52 clipboard handler. Without them, terminal-aware CLIs either fail to
 * detect a terminal at all, or render as if clipboard support doesn't exist.
 */

import { useEffect, useRef, useState } from "react";
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
      fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#0a0a0f",
        foreground: "#d4d4d8",
        cursor: "#5b7ef8",
        cursorAccent: "#0a0a0f",
        selectionBackground: "rgba(91, 126, 248, 0.3)",
      },
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

  const statusLabel =
    status === "connected" ? "Connected" : status === "error" ? (errorMessage ?? "Error") : "Connecting…";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      <div
        data-status={status}
        style={{
          fontSize: 11,
          fontFamily: "monospace",
          padding: "2px 8px",
          color: status === "error" ? "#ef4444" : status === "connected" ? "#22c55e" : "#f59e0b",
        }}
      >
        {statusLabel}
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, background: "#0a0a0f", padding: 4 }} />
    </div>
  );
};
