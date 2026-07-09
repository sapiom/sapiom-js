/**
 * End-to-end analytics tests: run the BUILT CLI (dist/bin.js) as a real
 * subprocess against an in-process mock collector and assert what actually
 * crosses the wire — envelopes, consent, the first-run notice, identity
 * placement (header, never payload), and fault tolerance.
 *
 * Built artifacts are guaranteed by jest.global-setup.cjs. Every run gets a
 * fresh temp HOME so machine identity, config, and credentials are isolated.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { FIRST_RUN_NOTICE } from '@sapiom/analytics-core';
import { startMockCollector, type MockCollector } from '@sapiom/analytics-core/testing';

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(PACKAGE_ROOT, 'dist', 'bin.js');
const CLI_VERSION = (
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run the built CLI. Async so the in-process mock collector can respond. */
function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) {
        // Spawn failure or hang — not a CLI exit; fail loudly.
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: error ? (error.code as number) : 0 });
    });
  });
}

/** A throwaway HOME so identity, config, and credentials never touch the real machine. */
function freshHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'sapiom-cli-analytics-e2e-'));
}

/**
 * A hermetic environment for one CLI run: every SAPIOM_* variable and
 * consent flag from the host is stripped, HOME/XDG point into the temp dir.
 */
function cliEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('SAPIOM_') || key === 'DO_NOT_TRACK' || key === 'NODE_OPTIONS') continue;
    env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, 'xdg');
  return { ...env, ...overrides };
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('command.run analytics (built CLI against a mock collector)', () => {
  let collector: MockCollector;

  beforeAll(async () => {
    expect(existsSync(BIN)).toBe(true);
    collector = await startMockCollector();
  });

  beforeEach(() => {
    collector.reset();
  });

  afterAll(async () => {
    await collector.close();
  });

  it('emits one command.run envelope with command path, flag names, duration, and exit status', async () => {
    const home = freshHome();
    const result = await runCli(
      ['config', 'set-target', 'staging', '--json'],
      cliEnv(home, { SAPIOM_ANALYTICS_ENDPOINT: collector.url }),
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, target: 'staging' });

    await collector.waitForRequests(1);
    const events = collector.events();
    expect(events).toHaveLength(1);

    const envelope = events[0];
    expect(envelope.event_type).toBe('command.run');
    expect(envelope.source).toBe('cli');
    expect(envelope.sdk_name).toBe('@sapiom/cli');
    expect(envelope.sdk_version).toBe(CLI_VERSION);
    expect(envelope.schema_version).toBe('1');
    expect(typeof envelope.anonymous_id).toBe('string');
    expect(typeof envelope.session_id).toBe('string');
    expect(envelope.user_id).toBeUndefined();

    expect(Object.keys(envelope.data).sort()).toEqual(['command', 'duration_ms', 'exit_code', 'flags']);
    expect(envelope.data.command).toBe('config set-target');
    expect(envelope.data.flags).toEqual(['--json']);
    expect(typeof envelope.data.duration_ms).toBe('number');
    expect(envelope.data.exit_code).toBe(0);

    // The positional value never reaches the wire in any form.
    expect(collector.requests[0].rawBody).not.toContain('staging');
  }, 20_000);

  it('reports the real exit code on failure and never the offending value', async () => {
    const home = freshHome();
    const result = await runCli(
      ['config', 'set-target', 'bogus-target-e2e-value'],
      cliEnv(home, { SAPIOM_ANALYTICS_ENDPOINT: collector.url }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown target');

    await collector.waitForRequests(1);
    const [envelope] = collector.events();
    expect(envelope.data.command).toBe('config set-target');
    expect(envelope.data.exit_code).toBe(1);
    expect(envelope.data.flags).toEqual([]);
    expect(collector.requests[0].rawBody).not.toContain('bogus-target-e2e-value');
  }, 20_000);

  it('login: tokens, codes, and org identifiers never reach the payload; identity travels as a header', async () => {
    const ACCESS_TOKEN = 'sk_e2e_login_secret_token';
    const DEVICE_CODE = 'e2e-device-code-secret';
    const USER_CODE = 'WXYZ-1234';
    const ORG_MARKER = 'e2e-org-user@example.com';

    // Minimal RFC 8628 stub that approves on the first poll. The verification
    // URL is deliberately non-https so the CLI's browser-opening guard skips it.
    const authServer = http.createServer((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/auth/device') {
          response.end(
            JSON.stringify({
              device_code: DEVICE_CODE,
              user_code: USER_CODE,
              verification_uri: 'http://127.0.0.1/activate',
              verification_uri_complete: `http://127.0.0.1/activate?code=${USER_CODE}`,
              expires_in: 60,
              interval: 1,
            }),
          );
        } else if (request.url === '/auth/device/token') {
          response.end(
            JSON.stringify({
              access_token: ACCESS_TOKEN,
              token_type: 'bearer',
              tenant_id: 'e2e-tenant',
              organization_name: ORG_MARKER,
            }),
          );
        } else {
          response.statusCode = 404;
          response.end('{}');
        }
      });
    });
    await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve));
    const { port } = authServer.address() as AddressInfo;

    try {
      const home = freshHome();
      const env = cliEnv(home, {
        SAPIOM_ANALYTICS_ENDPOINT: collector.url,
        SAPIOM_API_HOST: `http://127.0.0.1:${port}`,
      });
      const result = await runCli(['login', '--json'], env);

      expect(result.code).toBe(0);
      // Sanity: the flow really completed and stored the credential.
      const credentials = readFileSync(path.join(home, 'xdg', 'sapiom', 'credentials.json'), 'utf8');
      expect(credentials).toContain(ACCESS_TOKEN);

      await collector.waitForRequests(1);
      const [envelope] = collector.events();
      expect(envelope.data.command).toBe('login');
      expect(envelope.data.exit_code).toBe(0);
      expect(envelope.data.flags).toEqual(['--json']);

      for (const request of collector.requests) {
        expect(request.rawBody).not.toContain(ACCESS_TOKEN);
        expect(request.rawBody).not.toContain(DEVICE_CODE);
        expect(request.rawBody).not.toContain(USER_CODE);
        expect(request.rawBody).not.toContain(ORG_MARKER);
      }
      // The credential enriches server-side identity as a header, never as payload.
      expect(collector.requests[0].headers['x-sapiom-api-key']).toBe(ACCESS_TOKEN);
    } finally {
      await new Promise<void>((resolve) => authServer.close(() => resolve()));
    }
  }, 30_000);

  it('SAPIOM_API_KEY and stored credentials enrich the header but never the payload', async () => {
    const ENV_KEY = 'sk_e2e_env_key_secret';
    const STORED_KEY = 'sk_e2e_stored_credential_secret';

    const home = freshHome();
    const sapiomConfigDir = path.join(home, 'xdg', 'sapiom');
    mkdirSync(sapiomConfigDir, { recursive: true });
    writeFileSync(
      path.join(sapiomConfigDir, 'credentials.json'),
      JSON.stringify({ profiles: { default: { apiKey: STORED_KEY } } }),
    );

    const result = await runCli(
      ['logout', '--json'],
      cliEnv(home, { SAPIOM_ANALYTICS_ENDPOINT: collector.url, SAPIOM_API_KEY: ENV_KEY }),
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, cleared: true });

    await collector.waitForRequests(1);
    expect(collector.events()[0].data.command).toBe('logout');
    expect(collector.requests[0].headers['x-sapiom-api-key']).toBe(ENV_KEY);
    for (const request of collector.requests) {
      expect(request.rawBody).not.toContain(ENV_KEY);
      expect(request.rawBody).not.toContain(STORED_KEY);
    }
  }, 20_000);

  it('SAPIOM_TELEMETRY_DISABLED=1 and DO_NOT_TRACK=1 send nothing, with identical command output', async () => {
    const enabled = await runCli(
      ['logout', '--json'],
      cliEnv(freshHome(), { SAPIOM_ANALYTICS_ENDPOINT: collector.url }),
    );
    await collector.waitForRequests(1);
    expect(collector.requests).toHaveLength(1);

    collector.reset();
    const optedOut = await runCli(
      ['logout', '--json'],
      cliEnv(freshHome(), { SAPIOM_ANALYTICS_ENDPOINT: collector.url, SAPIOM_TELEMETRY_DISABLED: '1' }),
    );
    const doNotTrack = await runCli(
      ['logout', '--json'],
      cliEnv(freshHome(), { SAPIOM_ANALYTICS_ENDPOINT: collector.url, DO_NOT_TRACK: '1' }),
    );
    await settle(250);

    expect(collector.requests).toHaveLength(0);
    expect(optedOut.code).toBe(0);
    expect(doNotTrack.code).toBe(0);
    expect(optedOut.stdout).toBe(enabled.stdout);
    expect(doNotTrack.stdout).toBe(enabled.stdout);
    expect(optedOut.stderr).toBe('');
  }, 30_000);

  it('ships dark: without an endpoint nothing is sent, written, or printed', async () => {
    const home = freshHome();
    const result = await runCli(['logout', '--json'], cliEnv(home));
    await settle(250);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, cleared: false });
    expect(result.stderr).toBe('');
    expect(collector.requests).toHaveLength(0);
    // No identity file, no first-run marker — zero disk writes.
    expect(existsSync(path.join(home, '.sapiom', 'analytics.json'))).toBe(false);
  }, 20_000);

  it('prints the first-run notice exactly once per machine and stamps the marker', async () => {
    const home = freshHome();
    const env = cliEnv(home, { SAPIOM_ANALYTICS_ENDPOINT: collector.url });

    const first = await runCli(['logout', '--json'], env);
    expect(first.stderr).toContain(FIRST_RUN_NOTICE);

    const identity = JSON.parse(readFileSync(path.join(home, '.sapiom', 'analytics.json'), 'utf8')) as {
      anonymous_id: string;
      first_run_notice_at: string | null;
    };
    expect(typeof identity.anonymous_id).toBe('string');
    expect(typeof identity.first_run_notice_at).toBe('string');

    const second = await runCli(['logout', '--json'], env);
    expect(second.stderr).not.toContain(FIRST_RUN_NOTICE);

    await collector.waitForRequests(2);
    expect(collector.events()).toHaveLength(2);
    // Same machine identity across runs, distinct sessions.
    const [a, b] = collector.events();
    expect(a.anonymous_id).toBe(b.anonymous_id);
    expect(a.session_id).not.toBe(b.session_id);
  }, 30_000);

  it('collector faults never change command output or exit code', async () => {
    const args = ['config', 'set-target', 'local', '--json'];
    const baseline = await runCli(args, cliEnv(freshHome(), { SAPIOM_ANALYTICS_ENDPOINT: collector.url }));
    expect(baseline.code).toBe(0);

    // The collector kills every connection before responding.
    collector.setMode({ kind: 'down' });
    const whileDown = await runCli(args, cliEnv(freshHome(), { SAPIOM_ANALYTICS_ENDPOINT: collector.url }));
    expect(whileDown.code).toBe(0);
    expect(whileDown.stdout).toBe(baseline.stdout);

    // Nothing is listening at all (connection refused).
    collector.setMode({ kind: 'ok' });
    const refused = await runCli(
      args,
      cliEnv(freshHome(), { SAPIOM_ANALYTICS_ENDPOINT: 'http://127.0.0.1:9/v1/analytics/collector' }),
    );
    expect(refused.code).toBe(0);
    expect(refused.stdout).toBe(baseline.stdout);

    // The collector responds with a server error.
    collector.setMode({ kind: 'status', status: 500 });
    const serverError = await runCli(args, cliEnv(freshHome(), { SAPIOM_ANALYTICS_ENDPOINT: collector.url }));
    expect(serverError.code).toBe(0);
    expect(serverError.stdout).toBe(baseline.stdout);
  }, 40_000);

  it('a slow collector delays exit boundedly and never changes command output', async () => {
    const args = ['config', 'set-target', 'local', '--json'];
    const baseline = await runCli(args, cliEnv(freshHome(), { SAPIOM_ANALYTICS_ENDPOINT: collector.url }));
    expect(baseline.code).toBe(0);

    // Respond only after 8s — past the sender's 5s per-attempt timeout — so
    // the exit flush runs its worst case: one timed-out delivery attempt.
    collector.reset();
    collector.setMode({ kind: 'slow', delayMs: 8_000 });

    const startedAt = Date.now();
    const slow = await runCli(args, cliEnv(freshHome(), { SAPIOM_ANALYTICS_ENDPOINT: collector.url }));
    const wallMs = Date.now() - startedAt;

    expect(slow.code).toBe(0);
    expect(slow.stdout).toBe(baseline.stdout);
    // The exit flush genuinely waits through the timed-out attempt (measured
    // ≈5.1s locally: 5s request timeout + process startup)…
    expect(wallMs).toBeGreaterThan(4_500);
    // …but exit latency stays bounded — generous ceiling to absorb CI noise.
    expect(wallMs).toBeLessThan(12_000);
    // Exactly one attempt reaches the wire: after it times out, the retry
    // backoff timer is unref'd inside analytics-core, so it cannot hold the
    // exiting process open — the batch is dropped instead of retried.
    expect(collector.requests).toHaveLength(1);
  }, 45_000);
});
