/**
 * Harness server (workstreams W1/W3/W5).
 *
 * Single process: serves the built SPA from dist/web, the REST surface, and
 * the two WebSocket endpoints (/ws/terminal, /ws/events). Binds 127.0.0.1
 * only. See src/shared/types.ts for the full protocol contract.
 */

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { WebSocketServer } from "ws";

import type { HarnessAdapter, HarnessKind } from "../shared/types.js";
import { SessionManager, type LaunchOptsBuilder } from "../core/session-manager.js";
import { createClaudeCodeAdapter } from "../core/adapters/claude-code.js";
import { createCodexAdapter } from "../core/adapters/codex.js";
import { createBootTokenMiddleware } from "./auth.js";
import { createRestRouter } from "./rest.js";
import { createStaticRouter } from "./static.js";
import { createTerminalWebSocketHandler } from "./terminal-ws.js";
import { createEventsWebSocketHandler } from "./events-ws.js";
import { attachWebSocketRouters } from "./ws-router.js";

export interface HarnessServerOptions {
  port: number;
  /** Bind address. Defaults to 127.0.0.1 — the server must never listen on 0.0.0.0. */
  host?: string;
  /** Per-boot secret; required on WS upgrades, /api (header) and hook scripts (bearer). */
  bootToken: string;
  telemetryOptIn: boolean;
  /** Override the adapter set (tests inject a stubbed claude-code binary). */
  adapters?: Partial<Record<HarnessKind, HarnessAdapter>>;
  sessionsPath?: string;
  buildLaunchOpts?: LaunchOptsBuilder;
  collectorUrl?: string;
  /** Directory the built SPA lives in. Defaults to dist/web next to this module. */
  webDir?: string;
}

export interface HarnessServer {
  close(): Promise<void>;
  port: number;
  sessionManager: SessionManager;
}

// This module lives at either src/server/index.ts (tsx dev) or
// dist/server/index.js (built) — both are two directories below the package
// root, so this resolves correctly either way.
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const startServer = async (options: HarnessServerOptions): Promise<HarnessServer> => {
  const host = options.host ?? "127.0.0.1";
  const adapters: Partial<Record<HarnessKind, HarnessAdapter>> =
    options.adapters ??
    ({
      "claude-code": createClaudeCodeAdapter(),
      codex: createCodexAdapter(),
    } satisfies Partial<Record<HarnessKind, HarnessAdapter>>);

  const sessionManager = new SessionManager({
    adapters,
    ingestUrl: `http://${host}:${options.port}`,
    ingestToken: options.bootToken,
    collectorUrl: options.collectorUrl,
    sessionsPath: options.sessionsPath,
    buildLaunchOpts: options.buildLaunchOpts,
  });
  await sessionManager.init();

  const app: Express = express();
  app.disable("x-powered-by");

  app.use("/api", createBootTokenMiddleware(options.bootToken), createRestRouter({
    sessionManager,
    adapters,
    version: readVersion(),
  }));

  // NOTE: mount additional routers here (e.g. /ingest, /canvas) — the
  // static/SPA fallback below is a catch-all and must stay last.
  const webDir = options.webDir ?? join(packageRoot(), "dist", "web");
  app.use(createStaticRouter(webDir));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[harness] unhandled request error:", err);
    res.status(500).json({ error: "internal error" });
  });

  const httpServer: HttpServer = createHttpServer(app);

  const terminalWss = new WebSocketServer({ noServer: true });
  const eventsWss = new WebSocketServer({ noServer: true });
  attachWebSocketRouters(httpServer, [
    {
      path: "/ws/terminal",
      wss: terminalWss,
      onConnection: createTerminalWebSocketHandler(sessionManager, options.bootToken),
    },
    {
      path: "/ws/events",
      wss: eventsWss,
      onConnection: createEventsWebSocketHandler(sessionManager, options.bootToken),
    },
  ]);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;

  return {
    port: actualPort,
    sessionManager,
    close: () =>
      new Promise<void>((resolve, reject) => {
        terminalWss.close();
        eventsWss.close();
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
};
