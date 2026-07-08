/**
 * Minimal path-based router for WS upgrades on a shared HTTP server. `ws`
 * doesn't dispatch by path across multiple WebSocketServer instances on its
 * own when they're all attached with `noServer: true`, so this wires the
 * single `upgrade` event to the right one.
 */

import type { Server as HttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";

export interface WebSocketRoute {
  path: string;
  wss: WebSocketServer;
  onConnection: (ws: WebSocket, req: IncomingMessage, params: URLSearchParams) => void;
}

export function attachWebSocketRouters(server: HttpServer, routes: WebSocketRoute[]): void {
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes.find((r) => r.path === url.pathname);
    if (!route) {
      socket.destroy();
      return;
    }
    route.wss.handleUpgrade(req, socket, head, (ws) => {
      route.wss.emit("connection", ws, req);
    });
  });

  for (const route of routes) {
    route.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      route.onConnection(ws, req, url.searchParams);
    });
  }
}
