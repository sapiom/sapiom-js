/**
 * @sapiom/sandbox-preview — client-side flow for deploying a web-app preview to a
 * Sapiom sandbox: read `sapiom.json`, provision the sandbox, upload the source,
 * and call the server-side `previews` deploy op for a live URL.
 *
 * The deploy recipe itself lives server-side; this package only reads intent,
 * provisions, uploads, and triggers. Consumed by `@sapiom/cli` and the
 * `sapiom-dev` MCP.
 */
export { previewSandbox } from './preview.js';
export type { PreviewSandboxOptions } from './preview.js';

export { getSandbox, readSandboxes, writeSandbox, configureSandbox, checkSandboxes, CONFIG_FILE } from './config.js';

// Validation schema (single source of truth) — reused by the config reader, the
// `check` pass, and the MCP `configure` tool's typed arg schema (config-as-tool-args).
export { sandboxConfigBodySchema, storedSandboxSchema, CONFIG_VERSION } from './schema.js';
export type { SandboxConfigBody } from './schema.js';

export { PreviewOperationError } from './errors.js';
export type { StructuredError } from './errors.js';

export type { SandboxConfig, SandboxSourceSpec, PreviewResult } from './types.js';
