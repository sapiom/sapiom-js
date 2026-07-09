/**
 * End-to-end: deploy the fixture app to a REAL Sapiom sandbox on prod and assert
 * the preview URL serves 2xx. This provisions a real, TTL-bounded sandbox +
 * preview (real spend), so it is gated:
 *
 *   RUN_E2E=1 SAPIOM_API_KEY=<prod key> pnpm --filter @sapiom/sandbox-preview test:e2e
 *
 * Optional: SAPIOM_SERVICES_BASE / SAPIOM_SANDBOX_URL to target a non-prod gateway.
 * Without the gate it is skipped, so the default `jest` run stays offline.
 */
import path from 'node:path';

import { createClient } from '@sapiom/tools';

import { previewSandbox } from '../src/index.js';

const ENABLED = process.env.RUN_E2E === '1' && Boolean(process.env.SAPIOM_API_KEY);
const d = ENABLED ? describe : describe.skip;

const FIXTURE_DIR = path.join(__dirname, 'fixture');
const APP_NAME = 'sapiom-e2e-app';

d('sandbox preview upload deploy (prod)', () => {
  const apiKey = process.env.SAPIOM_API_KEY;
  const servicesBaseUrl = process.env.SAPIOM_SERVICES_BASE ?? process.env.SAPIOM_SANDBOX_URL;

  afterAll(async () => {
    try {
      const sapiom = createClient({ apiKey });
      const box = sapiom.sandboxes.attach(APP_NAME, servicesBaseUrl ? { baseUrl: servicesBaseUrl } : {});
      await box.destroy();
    } catch {
      /* best-effort teardown */
    }
  });

  it('provisions, uploads, starts, and serves a live preview URL', async () => {
    const result = await previewSandbox({
      dir: FIXTURE_DIR,
      apiKey,
      servicesBaseUrl,
      // eslint-disable-next-line no-console
      log: (msg) => console.error(`  ${msg}`),
    });

    expect(result.name).toBe(APP_NAME);
    expect(result.url).toMatch(/^https:\/\//);
    expect(result.status).toBe('deployed');

    const res = await fetch(`${result.url}/health`, { signal: AbortSignal.timeout(15_000) });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  }, 300_000);
});
