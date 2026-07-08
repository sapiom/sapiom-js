/**
 * Harness server (workstreams W1/W3/W5).
 *
 * Single process: serves the built SPA from dist/web, the REST surface and
 * /ingest, and the two WebSocket endpoints (/ws/terminal, /ws/events).
 * See src/shared/types.ts for the full protocol contract.
 */

export interface HarnessServerOptions {
  port: number;
  /** Per-boot secret; required on WS upgrades, /api (header) and /ingest (bearer). */
  bootToken: string;
  telemetryOptIn: boolean;
}

export interface HarnessServer {
  close(): Promise<void>;
  port: number;
}

export const startServer = async (
  options: HarnessServerOptions,
): Promise<HarnessServer> => {
  // W1 wires express + ws + SessionManager; W3 adds /ingest + collector;
  // W5 adds canvas watcher + macros.
  void options;
  throw new Error("not implemented yet (W1)");
};
