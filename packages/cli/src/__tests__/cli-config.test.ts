/**
 * Tests for host-switch resolution and CLI-level configuration.
 *
 * The key invariants:
 *   - SAPIOM_HOST env always wins
 *   - --host flag beats --target flag
 *   - --target local maps to localhost:3000, prod to api.sapiom.ai
 *   - Persisted config (target / host) is the fallback before project host
 *   - Project host from sapiom.json is the last fallback before default
 *   - Default is the production backend
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// We test resolveHost by mocking XDG_CONFIG_HOME to point at a temp dir so
// the test never touches the real ~/.sapiom/config.json.
import { resolveHost } from '../lib/cli-config.js';

const PROD = 'https://api.sapiom.ai';
const LOCAL = 'http://localhost:3000';

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `sapiom-cli-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfigJson(xdgDir: string, content: object): void {
  const sapiomDir = path.join(xdgDir, 'sapiom');
  if (!existsSync(sapiomDir)) mkdirSync(sapiomDir, { recursive: true });
  writeFileSync(path.join(sapiomDir, 'config.json'), JSON.stringify(content, null, 2) + '\n');
}

describe('resolveHost', () => {
  let originalXdg: string | undefined;
  let originalSapiomHost: string | undefined;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalSapiomHost = process.env.SAPIOM_HOST;
    // Isolate each test from real user config
    delete process.env.SAPIOM_HOST;
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    if (originalSapiomHost === undefined) {
      delete process.env.SAPIOM_HOST;
    } else {
      process.env.SAPIOM_HOST = originalSapiomHost;
    }
  });

  it('returns prod host by default', () => {
    const tmp = makeTmpDir();
    process.env.XDG_CONFIG_HOME = tmp;
    expect(resolveHost({})).toBe(PROD);
  });

  it('SAPIOM_HOST env wins over everything', () => {
    process.env.SAPIOM_HOST = 'https://my-custom.example.com';
    expect(resolveHost({ flagTarget: 'local', flagHost: 'http://other.example.com' })).toBe(
      'https://my-custom.example.com',
    );
  });

  it('--host flag wins over --target', () => {
    const tmp = makeTmpDir();
    process.env.XDG_CONFIG_HOME = tmp;
    expect(resolveHost({ flagHost: 'http://my-override.test', flagTarget: 'local' })).toBe(
      'http://my-override.test',
    );
  });

  it('--target local maps to localhost:3000', () => {
    const tmp = makeTmpDir();
    process.env.XDG_CONFIG_HOME = tmp;
    expect(resolveHost({ flagTarget: 'local' })).toBe(LOCAL);
  });

  it('--target prod maps to production host', () => {
    const tmp = makeTmpDir();
    process.env.XDG_CONFIG_HOME = tmp;
    expect(resolveHost({ flagTarget: 'prod' })).toBe(PROD);
  });

  it('persisted target=local in config.json is picked up when no flag is set', () => {
    const tmp = makeTmpDir();
    process.env.XDG_CONFIG_HOME = tmp;
    writeConfigJson(tmp, { target: 'local' });
    expect(resolveHost({})).toBe(LOCAL);
  });

  it('persisted host in config.json is picked up when no flag is set', () => {
    const tmp = makeTmpDir();
    process.env.XDG_CONFIG_HOME = tmp;
    writeConfigJson(tmp, { host: 'https://staging.example.com' });
    expect(resolveHost({})).toBe('https://staging.example.com');
  });

  it('persisted host takes precedence over persisted target', () => {
    const tmp = makeTmpDir();
    process.env.XDG_CONFIG_HOME = tmp;
    writeConfigJson(tmp, { host: 'https://staging.example.com', target: 'local' });
    expect(resolveHost({})).toBe('https://staging.example.com');
  });

  it('project host from sapiom.json is last fallback before default', () => {
    const tmp = makeTmpDir();
    process.env.XDG_CONFIG_HOME = tmp;
    // No config.json written — project host should apply
    expect(resolveHost({ projectHost: 'https://project-host.example.com' })).toBe(
      'https://project-host.example.com',
    );
  });

  it('flag target beats persisted config', () => {
    const tmp = makeTmpDir();
    process.env.XDG_CONFIG_HOME = tmp;
    writeConfigJson(tmp, { target: 'prod' });
    expect(resolveHost({ flagTarget: 'local' })).toBe(LOCAL);
  });

  it('strips trailing slash from host values', () => {
    process.env.SAPIOM_HOST = 'https://example.com/';
    expect(resolveHost({})).toBe('https://example.com');
  });
});
