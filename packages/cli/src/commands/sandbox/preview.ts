import { previewSandbox, PreviewOperationError } from '@sapiom/sandbox-preview';

import { resolveApiKey } from '../../lib/client.js';
import { CliError, isJsonMode, ok } from '../../lib/output.js';

/**
 * `sapiom sandbox preview [name]` — provision a sandbox (if needed), upload the
 * local code, build it, start it, and expose a live preview URL. Reads the
 * sandbox's declared intent from `sapiom.json` (`type: "sandbox"`, singular-default
 * when there's exactly one).
 */
export async function runPreview(name: string | undefined, opts: { servicesUrl?: string }): Promise<void> {
  try {
    const apiKey = resolveApiKey();
    const result = await previewSandbox({
      dir: process.cwd(),
      name,
      apiKey,
      servicesBaseUrl: opts.servicesUrl,
      // Progress goes to stderr so it never pollutes --json stdout.
      log: (msg) => {
        if (!isJsonMode()) process.stderr.write(`  ${msg}\n`);
      },
    });

    if (isJsonMode()) {
      ok({ name: result.name, url: result.url, status: result.status });
    } else if (result.status === 'failed') {
      ok({}, [`✗ ${result.name} build/start failed:`, result.logs]);
    } else {
      const verified = result.status === 'deployed' ? 'live' : 'started (unverified)';
      ok({}, [`✓ ${result.name} ${verified}: ${result.url}`]);
    }
  } catch (err) {
    if (err instanceof PreviewOperationError) throw new CliError(err.toStructured());
    throw err;
  }
}
