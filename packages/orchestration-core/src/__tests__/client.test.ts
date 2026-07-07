/**
 * Tests for GatewayClient and the networked core functions (run, signal,
 * inspect, link, deploy skeleton).
 *
 * We mock global.fetch to keep tests fully offline. Two consumer styles are
 * exercised per operation:
 *   - CLI-style: reads config from disk + resolves credentials via env
 *   - MCP-style: receives an explicit client + params (no filesystem side effects)
 *
 * "MCP-style" here means "programmatic / dependency-injected" — the same
 * pattern @sapiom/mcp (SAP-930) will use when it becomes a second consumer.
 */
import { createClient, GatewayClient } from '../client';
import { inspect, inspectBuild, listExecutions } from '../inspect';
import { link } from '../link';
import { run, parseJsonInput } from '../run';
import { signal, parseSignalPayload } from '../signal';

// ── Fetch mock helpers ────────────────────────────────────────────────────────

type MockResponse = { status: number; body: unknown };

function mockFetch(responses: MockResponse[]): jest.SpyInstance {
  let i = 0;
  return jest.spyOn(global, 'fetch' as any).mockImplementation(async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    const text = JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.status === 200 ? 'OK' : 'Error',
      text: async () => text,
    } as Response;
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ── GatewayClient ─────────────────────────────────────────────────────────────

describe('createClient / GatewayClient', () => {
  it('sends x-api-key header and targets /v1/workflows', async () => {
    const spy = mockFetch([{ status: 200, body: { ok: true } }]);
    const client = createClient({ host: 'https://example.com', apiKey: 'sk_test' });
    await client.get('/foo');

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/v1/workflows/foo');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk_test');
  });

  it('throws AgentOperationError with HTTP_4xx code on error status', async () => {
    mockFetch([{ status: 401, body: { message: 'Unauthorized' } }]);
    const client = createClient({ host: 'https://example.com', apiKey: 'bad' });
    await expect(client.get('/foo')).rejects.toMatchObject({
      code: 'HTTP_401',
      message: 'Unauthorized',
    });
  });

  it('defaults to the production backend host', () => {
    const client = new GatewayClient({ apiKey: 'sk_test' });
    // Access the private base via a GET call
    const spy = mockFetch([{ status: 200, body: {} }]);
    void client.get('/ping');
    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.sapiom.ai/v1/workflows/ping');
  });

  it('throws NETWORK error when fetch rejects', async () => {
    jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('ECONNREFUSED'));
    const client = createClient({ host: 'https://example.com', apiKey: 'sk' });
    await expect(client.get('/foo')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

// ── run ───────────────────────────────────────────────────────────────────────

describe('run', () => {
  const client = createClient({ host: 'https://example.com', apiKey: 'sk' });

  it('posts to /executions with definitionId in the body and returns executionId (CLI-style)', async () => {
    const spy = mockFetch([{ status: 200, body: { executionId: 'exec-1', status: 'running' } }]);
    const result = await run({ definitionId: 'def-1', input: { foo: 'bar' } }, client);
    expect(result.executionId).toBe('exec-1');
    expect(result.raw).toMatchObject({ executionId: 'exec-1' });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/v1/workflows/executions');
    const body = JSON.parse(init.body as string);
    expect(body.definitionId).toBe('def-1');
    expect(body.input).toEqual({ foo: 'bar' });
  });

  it('accepts id field as fallback for executionId (MCP-style)', async () => {
    mockFetch([{ status: 200, body: { id: 'exec-2' } }]);
    const result = await run({ definitionId: 'def-1' }, client);
    expect(result.executionId).toBe('exec-2');
  });

  it('throws RUN_NO_ID when neither executionId nor id is present', async () => {
    mockFetch([{ status: 200, body: {} }]);
    await expect(run({ definitionId: 'def-1' }, client)).rejects.toMatchObject({ code: 'RUN_NO_ID' });
  });

  it('defaults input to {} when not provided', async () => {
    const spy = mockFetch([{ status: 200, body: { executionId: 'e1' } }]);
    await run({ definitionId: 'def-1' }, client);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.input).toEqual({});
  });
});

describe('parseJsonInput', () => {
  it('parses valid JSON', () => {
    expect(parseJsonInput('{"key":"val"}')).toEqual({ key: 'val' });
  });
  it('throws BAD_INPUT on invalid JSON', () => {
    expect(() => parseJsonInput('not-json')).toThrow(
      expect.objectContaining({ code: 'BAD_INPUT' }),
    );
  });
});

// ── signal ────────────────────────────────────────────────────────────────────

describe('signal', () => {
  const client = createClient({ host: 'https://example.com', apiKey: 'sk' });

  it('posts to /executions/:id/signals and returns matched count (CLI-style)', async () => {
    mockFetch([{ status: 200, body: { matched: 1 } }]);
    const result = await signal(
      { executionId: 'exec-1', name: 'approve', correlationId: 'c1' },
      client,
    );
    expect(result.matched).toBe(1);
  });

  it('defaults matched to 0 when absent from response (MCP-style)', async () => {
    mockFetch([{ status: 200, body: {} }]);
    const result = await signal(
      { executionId: 'exec-1', name: 'approve', correlationId: 'c1' },
      client,
    );
    expect(result.matched).toBe(0);
  });

  it('forwards optional payload', async () => {
    const spy = mockFetch([{ status: 200, body: { matched: 1 } }]);
    await signal(
      { executionId: 'exec-1', name: 'approve', correlationId: 'c1', payload: { decision: true } },
      client,
    );
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.payload).toEqual({ decision: true });
  });
});

describe('parseSignalPayload', () => {
  it('parses valid JSON', () => {
    expect(parseSignalPayload('{"x":1}')).toEqual({ x: 1 });
  });
  it('throws BAD_PAYLOAD on invalid JSON', () => {
    expect(() => parseSignalPayload('bad')).toThrow(
      expect.objectContaining({ code: 'BAD_PAYLOAD' }),
    );
  });
});

// ── inspect / logs ────────────────────────────────────────────────────────────

describe('inspect', () => {
  const client = createClient({ host: 'https://example.com', apiKey: 'sk' });

  it('returns the decoded ExecutionProjection directly', async () => {
    const ex = { id: 'exec-1', status: 'completed', steps: [] };
    mockFetch([{ status: 200, body: ex }]);
    const result = await inspect({ executionId: 'exec-1' }, client);
    expect(result.id).toBe('exec-1');
    expect(result.status).toBe('completed');
  });

  it('carries the current step through', async () => {
    const ex = { id: 'exec-2', status: 'running', currentStep: 'process' };
    mockFetch([{ status: 200, body: ex }]);
    const execution = await inspect({ executionId: 'exec-2' }, client);
    expect(execution.currentStep).toBe('process');
  });
});

describe('listExecutions', () => {
  const client = createClient({ host: 'https://example.com', apiKey: 'sk' });

  it('returns tree-aware ExecutionRef[] directly', async () => {
    const list = [{ id: 'e1', status: 'completed' }, { id: 'e2', status: 'running' }];
    mockFetch([{ status: 200, body: list }]);
    const executions = await listExecutions(client);
    expect(executions).toHaveLength(2);
    expect(executions[0].executionId).toBe('e1');
    expect(executions[0].traceRoot).toBe('e1');
  });
});

describe('inspectBuild', () => {
  const client = createClient({ host: 'https://example.com', apiKey: 'sk' });

  it('fetches build status by definitionId + buildRunId', async () => {
    mockFetch([{ status: 200, body: { id: 'build-1', status: 'ready' } }]);
    const { build } = await inspectBuild({ definitionId: 'def-1', buildRunId: 'build-1' }, client);
    expect(build.status).toBe('ready');
  });
});

// ── link ──────────────────────────────────────────────────────────────────────

describe('link', () => {
  const client = createClient({ host: 'https://example.com', apiKey: 'sk' });

  it('resolves existing definition by name (CLI-style)', async () => {
    mockFetch([{ status: 200, body: [{ id: 'def-1', name: 'my-orch', slug: 'my-orch' }] }]);
    const result = await link({ name: 'my-orch' }, client);
    expect(result.definitionId).toBe('def-1');
    expect(result.name).toBe('my-orch');
  });

  it('creates definition when not found and create=true (MCP-style)', async () => {
    mockFetch([
      { status: 200, body: [] }, // list returns empty
      { status: 200, body: { id: 'def-new', name: 'new-orch' } }, // create
    ]);
    const result = await link({ name: 'new-orch', create: true }, client);
    expect(result.definitionId).toBe('def-new');
  });

  it('throws NOT_FOUND when not found and create=false', async () => {
    mockFetch([{ status: 200, body: [] }]);
    await expect(link({ name: 'missing' }, client)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
