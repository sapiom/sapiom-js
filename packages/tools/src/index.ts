/**
 * `@sapiom/tools` — the typed Sapiom capability client.
 *
 * The same catalog your agents call over MCP, callable from code. Capabilities are
 * namespaces (`sandboxes`, `repositories`, `agent`, `fileStorage`, … ), importable
 * from the barrel or a subpath:
 *
 *   import { sandboxes } from "@sapiom/tools";
 *   import { sandboxes } from "@sapiom/tools/sandboxes";
 *
 * Auth is implicit: ambient (engine-injected) inside a workflow step, or explicit
 * via `createClient({ apiKey })` standalone.
 */
export { createClient, createClientFromEnv } from "./client.js";
export type { Sapiom } from "./client.js";
export type { TransportConfig, Attribution } from "./_client/index.js";

// The generic dispatch contract: any capability handle that carries a `dispatch`
// member is pausable via `pauseUntilSignal` in @sapiom/orchestration.
export type { DispatchHandle } from "./dispatch.js";

export * as sandboxes from "./sandboxes/index.js";
export { Sandbox } from "./sandboxes/index.js";

export * as repositories from "./repositories/index.js";
export { Repository } from "./repositories/index.js";

export * as agent from "./agent/index.js";
// Surfaced top-level for the static `pause: { signal }` decl on a workflow step.
export { CODING_RESULT_SIGNAL } from "./agent/index.js";
// The shape a step resumed from `pauseUntilSignal(codingHandle, …)` receives as
// input — annotate the resumed step with it instead of hand-rolling the shape.
export type { CodingResultPayload } from "./agent/index.js";

export * as fileStorage from "./file-storage/index.js";
export { FileStorageHttpError } from "./file-storage/index.js";
