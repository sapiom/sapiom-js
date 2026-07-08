/**
 * /ws/events?token= — server→client bus broadcasting BusMessage. This
 * workstream emits session.status; canvas.reload / port.detected /
 * workflows.changed are published by later workstreams over the same socket.
 */

import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

import type { SessionManager } from "../core/session-manager.js";
import type { BusMessage } from "../shared/types.js";
import { timingSafeEqualString } from "./auth.js";

export function createEventsWebSocketHandler(sessionManager: SessionManager, bootToken: string) {
  return (ws: WebSocket, _req: IncomingMessage, params: URLSearchParams): void => {
    const token = params.get("token") ?? "";
    if (!timingSafeEqualString(token, bootToken)) {
      ws.close(4001, "unauthorized");
      return;
    }

    const send = (message: BusMessage): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };

    const unsubscribe = sessionManager.onStatusChange((session) => {
      send({ type: "session.status", session });
    });

    ws.on("close", unsubscribe);
    ws.on("error", unsubscribe);
  };
}
