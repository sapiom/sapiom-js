/**
 * A project's `sapiom.json` is committed and can come from a cloned template,
 * so a `host` in it must never decide where the API key is sent. Every command
 * that builds an authenticated client is run against a project whose
 * `sapiom.json` names a foreign host, and the host each client was built for
 * is asserted.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockCreateClient = jest.fn((opts: { host: string; apiKey: string }) => ({ host: opts.host }));
const mockRun = jest.fn();

jest.mock('@sapiom/agent-core', () => ({
  ...jest.requireActual('@sapiom/agent-core'),
  createClient: (opts: { host: string; apiKey: string }) => mockCreateClient(opts),
  run: (...args: unknown[]) => mockRun(...args),
  deploy: async () => ({ definitionId: 'def-1', buildRunId: 'b-1', status: 'succeeded' }),
  inspectBuild: async () => ({ build: { status: 'succeeded' } }),
  listExecutions: async () => [],
  inspect: async () => ({ id: 'ex-1', status: 'completed', steps: [] }),
  signal: async () => ({ matched: 1 }),
  emitEvent: async () => ({ receiptId: 'r-1', outcome: 'unmatched', duplicate: false, fireIds: [] }),
  listSchedules: async () => [],
}));

import { runDeploy } from '../commands/agents/deploy.js';
import { runEmit } from '../commands/agents/emit.js';
import { runLogs } from '../commands/agents/logs.js';
import { runRun } from '../commands/agents/run.js';
import { runScheduleList } from '../commands/agents/schedule.js';
import { runSignal } from '../commands/agents/signal.js';

const PROD = 'https://api.sapiom.ai';
const STAGING = 'https://api.sapiom.dev';
const FOREIGN = 'https://evil.example';

const ENV_KEYS = ['XDG_CONFIG_HOME', 'SAPIOM_HOST', 'SAPIOM_API_KEY'] as const;

describe('sapiom.json host is never a credential destination', () => {
  let tmp: string;
  let xdg: string;
  let originalCwd: string;
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    tmp = mkdtempSync(path.join(os.tmpdir(), 'sapiom-project-host-'));
    xdg = path.join(tmp, 'xdg');
    const project = path.join(tmp, 'project');
    mkdirSync(xdg);
    mkdirSync(project);
    writeFileSync(
      path.join(project, 'sapiom.json'),
      JSON.stringify({ definitionId: 'def-1', name: 'agent', host: FOREIGN }),
    );
    originalCwd = process.cwd();
    process.chdir(project);
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.SAPIOM_API_KEY = 'sk_test_key';
    delete process.env.SAPIOM_HOST;
    mockCreateClient.mockClear();
    mockRun.mockReset().mockResolvedValue({ executionId: 'ex-1', raw: {} });
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    process.chdir(originalCwd);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  const commands: Array<[string, () => Promise<void>]> = [
    ['agents run', () => runRun({})],
    ['agents deploy', () => runDeploy({})],
    ['agents logs', () => runLogs(undefined, {})],
    ['agents logs <id>', () => runLogs('ex-1', {})],
    ['agents logs --build', () => runLogs(undefined, { build: 'b-1' })],
    ['agents signal', () => runSignal('ex-1', { name: 'go', correlationId: 'c-1' })],
    ['agents emit', () => runEmit('thing.happened', { payload: '{}' })],
    ['agents schedule list', () => runScheduleList('agent', {})],
  ];

  it.each(commands)('%s sends the key to the production host, not the project host', async (_name, command) => {
    await command();

    expect(mockCreateClient).toHaveBeenCalled();
    for (const [opts] of mockCreateClient.mock.calls) {
      expect(opts.host).toBe(PROD);
      expect(opts.host).not.toContain('evil.example');
      expect(opts.apiKey).toBe('sk_test_key');
    }
  });

  it('still reads the linked definition from the same sapiom.json', async () => {
    await runRun({});

    expect(mockRun).toHaveBeenCalledWith({ definitionId: 'def-1', input: {} }, expect.anything());
  });

  it('honours an explicit --host flag', async () => {
    await runRun({ host: STAGING });

    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ host: STAGING }));
  });

  it('honours the persisted target over the ignored project host', async () => {
    mkdirSync(path.join(xdg, 'sapiom'));
    writeFileSync(path.join(xdg, 'sapiom', 'config.json'), JSON.stringify({ target: 'staging' }));

    await runRun({});

    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ host: STAGING }));
  });
});
