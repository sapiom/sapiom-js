/**
 * Tests for `sapiom agents signal` — specifically that the server's `message`
 * reaches the user on both surfaces.
 *
 * It matters because `matched` counts the runs that ACTUALLY resumed, not the
 * ones that matched the `(name, correlationId)` pair. The server sends
 * `message` exactly when that count needs qualifying, so a CLI that printed
 * only the count would state the ambiguous half and swallow the half that
 * resolves it: `matched 0` reads as "nothing was waiting" when the truth may be
 * "two waiters matched and neither resumed".
 */
import { signal } from '@sapiom/agent-core';

import { setJsonMode } from '../../lib/output.js';
import { runSignal } from './signal.js';

jest.mock('@sapiom/agent-core', () => {
  const actual = jest.requireActual('@sapiom/agent-core');
  return { ...actual, signal: jest.fn() };
});

jest.mock('../../lib/client.js', () => ({
  makeClient: jest.fn(() => ({})),
}));

const OPTS = { name: 'approval.decision', correlationId: 'exec-1' };

function captureStdout(): { lines: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe('runSignal', () => {
  afterEach(() => {
    setJsonMode(false);
    jest.restoreAllMocks();
    jest.mocked(signal).mockReset();
  });

  it('prints the message under the success line when the server qualifies the count', async () => {
    jest.mocked(signal).mockResolvedValue({
      matched: 0,
      message: 'Two waiters matched, but neither resumed.',
    });
    const out = captureStdout();

    await runSignal('exec-1', OPTS);

    expect(out.lines()).toContain('matched 0');
    expect(out.lines()).toContain('Two waiters matched, but neither resumed.');
    out.restore();
  });

  it('includes the message under --json', async () => {
    jest.mocked(signal).mockResolvedValue({
      matched: 0,
      message: 'No execution was waiting on that pair.',
    });
    setJsonMode(true);
    const out = captureStdout();

    await runSignal('exec-1', OPTS);
    const payload = JSON.parse(out.lines());

    expect(payload).toMatchObject({
      ok: true,
      matched: 0,
      message: 'No execution was waiting on that pair.',
    });
    out.restore();
  });

  it('omits message entirely on a clean fanout', async () => {
    jest.mocked(signal).mockResolvedValue({ matched: 2 });
    setJsonMode(true);
    const out = captureStdout();

    await runSignal('exec-1', OPTS);
    const payload = JSON.parse(out.lines());

    expect(payload).toEqual({ ok: true, matched: 2 });
    expect('message' in payload).toBe(false);
    out.restore();
  });
});
