/**
 * /ws/events?token= — server→client bus broadcasting BusMessage. Forwards
 * whatever the shared EventBus publishes (session.status, canvas.reload,
 * port.detected, workflows.changed) — the integrator is responsible for
 * feeding all of those into the bus from their respective sources.
 */

import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

import type { EventBus } from "../core/event-bus.js";
import type { BusMessage } from "../shared/types.js";
import { timingSafeEqualString } from "./auth.js";

export function createEventsWebSocketHandler(bus: EventBus, bootToken: string) {
  return (ws: WebSocket, _req: IncomingMessage, params: URLSearchParams): void => {
    const token = params.get("token") ?? "";
    if (!timingSafeEqualString(token, bootToken)) {
      ws.close(4001, "unauthorized");
      return;
    }

    const send = (message: BusMessage): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };

    const unsubscribe = bus.subscribe(send);

    ws.on("close", unsubscribe);
    ws.on("error", unsubscribe);
  };
}
