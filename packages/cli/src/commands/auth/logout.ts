import { ok } from '../../lib/output.js';
import { clearCredential } from '../../lib/session.js';

/**
 * `sapiom logout` — clear the locally stored credential. (The credential
 * remains valid server-side until revoked in the dashboard.)
 */
export async function runLogout(): Promise<void> {
  const cleared = clearCredential();
  ok({ cleared }, [cleared ? '✓ Logged out (local credential cleared).' : 'No stored credential to clear.']);
}
