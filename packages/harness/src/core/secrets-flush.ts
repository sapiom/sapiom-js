/**
 * secrets-flush — moving locally-authored credentials into the vault once the
 * agent they belong to exists in the cloud.
 *
 * Called from two places, and both matter: the deploy route (right after a
 * definition id first exists) and the tab's explicit "Upload pending" action,
 * which is the answer for a user who deployed from the terminal — the `deploy`
 * macro types `sapiom agents deploy` into the pty, and the harness server never
 * sees that happen.
 *
 * ONE AT A TIME, BY NECESSITY. `POST .../secrets` takes a single `{ key,
 * secret }`; there is no bulk write. So a flush is N requests and can therefore
 * partly succeed — which is why this returns per-key outcomes instead of a
 * boolean. Reporting "uploaded" for a run that landed four of six keys is the
 * exact failure the Secrets surface exists to prevent.
 *
 * THE LOCAL COPY SURVIVES A SUCCESSFUL UPLOAD. The vault has no read path, so
 * once a local value is gone the harness can never re-populate it, and local
 * runs would silently stop receiving credentials at the moment the agent starts
 * working in the cloud. Removing the local copy is its own explicit action.
 */

import type { PendingSecretsStore } from "./pending-secrets.js";
import { VaultSecretError, type VaultSecretsClient } from "./vault-secrets.js";

export interface SecretFlushResult {
  /** Names that reached the vault, in the order attempted. */
  uploaded: string[];
  /** Names that did not, each with a sentence naming what to do about it. */
  failed: { key: string; error: string }[];
}

/**
 * Uploads every pending value for `projectPath` to `definitionId`.
 *
 * Never throws: a transport failure on key three must not hide that keys one
 * and two landed, so every outcome is collected and returned. Sequential
 * rather than parallel — these are writes to one definition, and a burst of
 * concurrent writes to the same namespace buys nothing but a harder failure
 * story.
 */
export async function flushPendingSecrets(opts: {
  pending: PendingSecretsStore;
  vault: VaultSecretsClient;
  /** Absolute project directory — the pending store's key. */
  projectPath: string;
  /** The cloud definition the values belong to. */
  definitionId: string;
}): Promise<SecretFlushResult> {
  const result: SecretFlushResult = { uploaded: [], failed: [] };

  for (const { key, value } of opts.pending.entries(opts.projectPath)) {
    try {
      await opts.vault.set(opts.definitionId, key, value);
      result.uploaded.push(key);
    } catch (err) {
      result.failed.push({
        key,
        error:
          err instanceof VaultSecretError
            ? err.message
            : `${key} could not be stored: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return result;
}
