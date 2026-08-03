/**
 * sendFeedback — assert it POSTs to the host-rooted `/v1/studio-feedback`
 * (never the `/v1/workflows` base), omits absent optionals rather than sending
 * empties, and tolerates a response body that doesn't carry an id. The
 * GatewayClient is faked to record calls.
 */
import type { GatewayClient } from './client.js';
import { sendFeedback } from './feedback.js';

interface Call {
  path: string;
  body?: unknown;
}

function fakeClient(response: unknown = { id: 'fb_1' }): {
  client: GatewayClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    postAtHostRoot: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      return response;
    },
    // Present so a regression that reaches for the workflows-relative helpers
    // fails loudly rather than silently hitting the wrong base.
    post: async () => {
      throw new Error('sendFeedback must not use the /v1/workflows base');
    },
  } as unknown as GatewayClient;
  return { client, calls };
}

describe('sendFeedback', () => {
  it('POSTs the host-rooted studio-feedback route', async () => {
    const { client, calls } = fakeClient();
    await sendFeedback({ message: 'the deploy button does nothing' }, client);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/v1/studio-feedback');
  });

  it('forwards message, context and clientMeta', async () => {
    const { client, calls } = fakeClient();
    await sendFeedback(
      {
        message: 'the deploy button does nothing',
        context: 'after run_local passed',
        clientMeta: { client: 'sapiom-mcp', platform: 'darwin' },
      },
      client,
    );
    expect(calls[0].body).toEqual({
      message: 'the deploy button does nothing',
      context: 'after run_local passed',
      clientMeta: { client: 'sapiom-mcp', platform: 'darwin' },
    });
  });

  it('omits context and clientMeta when absent', async () => {
    const { client, calls } = fakeClient();
    await sendFeedback({ message: 'hi' }, client);
    expect(calls[0].body).toEqual({ message: 'hi' });
  });

  it('omits an empty context string and an empty clientMeta object', async () => {
    const { client, calls } = fakeClient();
    await sendFeedback({ message: 'hi', context: '', clientMeta: {} }, client);
    expect(calls[0].body).toEqual({ message: 'hi' });
  });

  it('treats an explicit null context/clientMeta as absent rather than throwing', async () => {
    // A JS caller, or anything built from JSON.parse, can hand us null where
    // the type says undefined. Object.keys(null) throws.
    const { client, calls } = fakeClient();
    await sendFeedback(
      { message: 'hi', context: null, clientMeta: null } as never,
      client,
    );
    expect(calls[0].body).toEqual({ message: 'hi' });
  });

  it('returns the server-assigned id', async () => {
    const { client } = fakeClient({ id: 'fb_42' });
    await expect(sendFeedback({ message: 'hi' }, client)).resolves.toEqual({ id: 'fb_42' });
  });

  it('tolerates a response with no id rather than throwing', async () => {
    const { client } = fakeClient({});
    await expect(sendFeedback({ message: 'hi' }, client)).resolves.toEqual({ id: undefined });
  });

  it('ignores a non-string id', async () => {
    const { client } = fakeClient({ id: 42 });
    await expect(sendFeedback({ message: 'hi' }, client)).resolves.toEqual({ id: undefined });
  });

  it('tolerates an empty (undefined) response body', async () => {
    // Built inline rather than via fakeClient(undefined) — that would land on
    // the default parameter and quietly test the happy path instead.
    const client = {
      postAtHostRoot: async () => undefined,
    } as unknown as GatewayClient;
    await expect(sendFeedback({ message: 'hi' }, client)).resolves.toEqual({ id: undefined });
  });

  it('propagates gateway errors untouched', async () => {
    const client = {
      postAtHostRoot: async () => {
        throw Object.assign(new Error('Unauthorized'), { code: 'HTTP_401' });
      },
    } as unknown as GatewayClient;
    await expect(sendFeedback({ message: 'hi' }, client)).rejects.toMatchObject({
      code: 'HTTP_401',
    });
  });
});
