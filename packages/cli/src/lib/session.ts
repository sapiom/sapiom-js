/**
 * The session store: credentials persisted by `sapiom login`, keyed by profile.
 * Written 0600 under a 0700 dir. A credential is either OAuth tokens (from the
 * device flow) or a raw API key; the API key in the environment always takes
 * precedence over anything stored here (see the client).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { configDir, credentialsPath } from './paths.js';

export const DEFAULT_PROFILE = 'default';

export interface StoredCredential {
  /** A raw, durable API key (e.g. sk_…). */
  apiKey?: string;
  /** Short-lived access token from the device flow. */
  accessToken?: string;
  /** Long-lived refresh token used to mint new access tokens. */
  refreshToken?: string;
  /** Access-token expiry, epoch ms. */
  expiresAt?: number;
  /** Optional host this credential is for. */
  host?: string;
}

interface CredentialsFile {
  profiles: Record<string, StoredCredential>;
}

function load(): CredentialsFile {
  const file = credentialsPath();
  if (!existsSync(file)) return { profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CredentialsFile;
    return parsed.profiles ? parsed : { profiles: {} };
  } catch {
    return { profiles: {} };
  }
}

function persist(data: CredentialsFile): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsPath();
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600); // enforce 0600 even if the file pre-existed
}

export function readCredential(profile = DEFAULT_PROFILE): StoredCredential | null {
  return load().profiles[profile] ?? null;
}

export function writeCredential(cred: StoredCredential, profile = DEFAULT_PROFILE): void {
  const data = load();
  data.profiles[profile] = cred;
  persist(data);
}

export function clearCredential(profile = DEFAULT_PROFILE): boolean {
  const data = load();
  if (!data.profiles[profile]) return false;
  delete data.profiles[profile];
  persist(data);
  return true;
}
