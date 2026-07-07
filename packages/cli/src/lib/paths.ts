/**
 * Where the CLI keeps per-machine session state. XDG-aware
 * (`$XDG_CONFIG_HOME/sapiom`), falling back to `~/.sapiom`. This is *session*
 * state (credentials, profiles) — never domain state; the server stays the
 * source of truth for what agents exist.
 */
import { homedir } from 'node:os';
import path from 'node:path';

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, 'sapiom') : path.join(homedir(), '.sapiom');
}

export function credentialsPath(): string {
  return path.join(configDir(), 'credentials.json');
}

export function configFilePath(): string {
  return path.join(configDir(), 'config.json');
}
