/**
 * Placeholder terminal slot. The real xterm.js implementation (WS bridge,
 * XDA/OSC-52 handling) ships at this exact path from the terminal-core
 * workstream — this keeps the props signature stable so the SPA shell wires
 * up cleanly either way.
 */
import type { JSX } from "react";

export interface TerminalProps {
  sessionId: string;
  token: string;
}

export function Terminal({ sessionId }: TerminalProps): JSX.Element {
  return (
    <div className="terminal-placeholder">
      <div className="terminal-placeholder-text">terminal loading…</div>
      <div className="terminal-placeholder-session">session {sessionId}</div>
    </div>
  );
}
