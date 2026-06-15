/**
 * `@sapiom/tools` — the typed Sapiom capability client.
 *
 * The same catalog your agents call over MCP, callable from code. Capabilities are
 * namespaces (`sandboxes`, `repositories`, `agent`, … ), importable from the barrel
 * or a subpath:
 *
 *   import { sandboxes } from "@sapiom/tools";
 *   import { sandboxes } from "@sapiom/tools/sandboxes";
 *
 * Auth is implicit: ambient (engine-injected) inside a workflow step, or explicit
 * via `createClient({ apiKey })` standalone.
 */
export { createClient } from "./client.js";
export type { Sapiom } from "./client.js";
export type { TransportConfig, Attribution } from "./_client/index.js";

export * as sandboxes from "./sandboxes/index.js";
export { Sandbox } from "./sandboxes/index.js";

export * as repositories from "./repositories/index.js";
export { Repository } from "./repositories/index.js";

export * as agent from "./agent/index.js";
