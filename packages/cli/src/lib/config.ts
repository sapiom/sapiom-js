/**
 * Re-export `sapiom.json` helpers from @sapiom/agent-core. The CLI
 * commands catch AgentOperationError themselves (where they already do so for
 * other core operations) and convert to CliError for uniform rendering.
 */
export { readConfig, requireConfig, writeConfig, CONFIG_FILE } from '@sapiom/agent-core';
export type { SapiomConfig } from '@sapiom/agent-core';
