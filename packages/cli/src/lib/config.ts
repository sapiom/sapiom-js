/**
 * Re-export `sapiom.json` helpers from @sapiom/orchestration-core. The CLI
 * commands catch OrchestrationError themselves (where they already do so for
 * other core operations) and convert to CliError for uniform rendering.
 */
export { readConfig, requireConfig, writeConfig, CONFIG_FILE } from '@sapiom/orchestration-core';
export type { SapiomConfig } from '@sapiom/orchestration-core';
