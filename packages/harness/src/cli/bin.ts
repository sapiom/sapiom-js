#!/usr/bin/env node
/**
 * sapiom-harness CLI entry (workstream W4).
 *
 * Flow: doctor → auth (reuse @sapiom/mcp browser OAuth) → consent (first run)
 * → boot server → open browser → create first session in [dir].
 *
 * Flags: [dir] (default cwd), --port, --no-auth, --no-telemetry, --no-open, --dev.
 */

const main = async (): Promise<void> => {
  // W4 implements. Keep bin.js executable and side-effect free on import.
  process.stdout.write("sapiom-harness: not implemented yet (W4)\n");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
