/**
 * /ws/terminal?session=&token= — raw pty bytes both ways, JSON {type:"resize"}
 * control frames from client to server. See src/shared/types.ts for the protocol.
 */

import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

import type { SessionManager } from "../core/session-manager.js";
import type { TerminalControlMessage } from "../shared/types.js";
import { timingSafeEqualString } from "./auth.js";

const TERMINAL_INPUT_FAILURE_CODE = 1011;
const TERMINAL_INPUT_FAILURE_REASON = "terminal input unavailable";

function parseControlMessage(text: string): TerminalControlMessage | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<TerminalControlMessage>;
    if (
      parsed.type === "resize" &&
      typeof parsed.cols === "number" &&
      typeof parsed.rows === "number"
    ) {
      return { type: "resize", cols: parsed.cols, rows: parsed.rows };
    }
  } catch {
    // Not JSON — treat as raw terminal input.
  }
  return undefined;
}

export function createTerminalWebSocketHandler(
  sessionManager: SessionManager,
  bootToken: string,
) {
  return (
    ws: WebSocket,
    _req: IncomingMessage,
    params: URLSearchParams,
  ): void => {
    const sessionId = params.get("session");
    const token = params.get("token") ?? "";

    if (!timingSafeEqualString(token, bootToken)) {
      ws.close(4001, "unauthorized");
      return;
    }
    if (!sessionId) {
      ws.close(4008, "missing session parameter");
      return;
    }
    if (!sessionManager.get(sessionId)) {
      ws.close(4004, "session not found");
      return;
    }

    const detach = sessionManager.attach(sessionId, (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    if (!detach) {
      ws.close(4004, "session has no live pty");
      return;
    }

    let detached = false;
    let inputClosed = false;
    const detachOnce = (): void => {
      if (detached) return;
      detached = true;
      detach();
    };

    ws.on("message", (data, isBinary) => {
      if (inputClosed) return;
      const text = data.toString("utf8");
      if (!isBinary) {
        const control = parseControlMessage(text);
        if (control) {
          sessionManager.resize(sessionId, control.cols, control.rows);
          return;
        }
      }
      try {
        sessionManager.write(sessionId, text);
      } catch {
        // A partial PTY write can deliberately fence the composer until it is
        // reset. Never let that synchronous safety failure escape EventEmitter
        // as an uncaught exception, and never expose input or provider details
        // in the close frame. The client may reconnect and retry once the
        // handle's non-submitting reset succeeds.
        inputClosed = true;
        detachOnce();
        ws.close(TERMINAL_INPUT_FAILURE_CODE, TERMINAL_INPUT_FAILURE_REASON);
      }
    });

    ws.on("close", detachOnce);
    ws.on("error", detachOnce);
  };
}
