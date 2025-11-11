/**
 * Tests for LangChain integration utilities
 */

import {
  generateSDKTraceId,
  waitForTransactionAuthorization,
  isAuthorizationDenied,
  AuthorizationDeniedError,
  convertInputToMessages,
} from './utils';
import { SapiomClient } from '../../../lib/SapiomClient';

describe('generateSDKTraceId', () => {
  it('generates unique trace IDs with sdk- prefix', () => {
    const id1 = generateSDKTraceId();
    const id2 = generateSDKTraceId();

    expect(id1).toMatch(/^sdk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id2).toMatch(/^sdk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id1).not.toBe(id2);
  });

  it('generates valid UUID v4 format', () => {
    const id = generateSDKTraceId();

    // Remove sdk- prefix
    const uuid = id.substring(4);

    // Validate UUID v4 format (8-4-4-4-12 hex digits)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuid).toMatch(uuidRegex);
  });
});

describe('waitForTransactionAuthorization', () => {
  let mockClient: SapiomClient;

  beforeEach(() => {
    mockClient = {
      transactions: {
        get: jest.fn(),
      },
    } as any;
  });

  it('returns transaction when authorized immediately', async () => {
    const authorizedTx = { id: 'tx-123', status: 'authorized' };
    (mockClient.transactions.get as jest.Mock).mockResolvedValue(authorizedTx);

    const result = await waitForTransactionAuthorization('tx-123', mockClient);

    expect(result).toEqual(authorizedTx);
    expect(mockClient.transactions.get).toHaveBeenCalledWith('tx-123');
    expect(mockClient.transactions.get).toHaveBeenCalledTimes(1);
  });

  it('polls until authorized', async () => {
    const pendingTx = { id: 'tx-123', status: 'pending' };
    const authorizedTx = { id: 'tx-123', status: 'authorized' };

    (mockClient.transactions.get as jest.Mock)
      .mockResolvedValueOnce(pendingTx)
      .mockResolvedValueOnce(pendingTx)
      .mockResolvedValueOnce(authorizedTx);

    const result = await waitForTransactionAuthorization('tx-123', mockClient, {
      pollIntervalMs: 10,
    });

    expect(result).toEqual(authorizedTx);
    expect(mockClient.transactions.get).toHaveBeenCalledTimes(3);
  });

  it('accepts "authorized" status variations', async () => {
    const authorizedTx = { id: 'tx-123', status: 'authorized' };
    (mockClient.transactions.get as jest.Mock).mockResolvedValue(authorizedTx);

    const result = await waitForTransactionAuthorization('tx-123', mockClient);

    expect(result).toEqual(authorizedTx);
  });

  it('throws AuthorizationDeniedError when denied', async () => {
    const deniedTx = {
      id: 'tx-123',
      status: 'denied',
      declineReason: 'Budget exceeded',
    };
    (mockClient.transactions.get as jest.Mock).mockResolvedValue(deniedTx);

    await expect(waitForTransactionAuthorization('tx-123', mockClient)).rejects.toThrow(
      /Budget exceeded/,
    );
  });

  it('throws AuthorizationDeniedError when cancelled', async () => {
    const cancelledTx = { id: 'tx-123', status: 'cancelled' };
    (mockClient.transactions.get as jest.Mock).mockResolvedValue(cancelledTx);

    await expect(waitForTransactionAuthorization('tx-123', mockClient)).rejects.toThrow(
      AuthorizationDeniedError,
    );
  });

  it('throws timeout error after timeout period', async () => {
    const pendingTx = { id: 'tx-123', status: 'pending' };
    (mockClient.transactions.get as jest.Mock).mockResolvedValue(pendingTx);

    await expect(
      waitForTransactionAuthorization('tx-123', mockClient, {
        timeoutMs: 100,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow(/timeout after 100ms/);
  });

  it('uses default polling options', async () => {
    const authorizedTx = { id: 'tx-123', status: 'authorized' };
    (mockClient.transactions.get as jest.Mock).mockResolvedValue(authorizedTx);

    await waitForTransactionAuthorization('tx-123', mockClient);

    // Should work with defaults (no error thrown)
    expect(mockClient.transactions.get).toHaveBeenCalled();
  });
});

describe('AuthorizationDeniedError', () => {
  it('creates error with transaction ID', () => {
    const error = new AuthorizationDeniedError('Budget exceeded', 'tx-123');

    expect(error.message).toBe('Budget exceeded');
    expect(error.txId).toBe('tx-123');
    expect(error.name).toBe('AuthorizationDeniedError');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('isAuthorizationDenied', () => {
  it('returns true for AuthorizationDeniedError', () => {
    const error = new AuthorizationDeniedError('Test', 'tx-123');
    expect(isAuthorizationDenied(error)).toBe(true);
  });

  it('returns false for other errors', () => {
    const error = new Error('Regular error');
    expect(isAuthorizationDenied(error)).toBe(false);
  });

  it('returns false for non-Error objects', () => {
    expect(isAuthorizationDenied('string')).toBe(false);
    expect(isAuthorizationDenied(null)).toBe(false);
    expect(isAuthorizationDenied(undefined)).toBe(false);
    expect(isAuthorizationDenied({ message: 'object' })).toBe(false);
  });
});

describe('convertInputToMessages', () => {
  it('converts string to user message', () => {
    const result = convertInputToMessages('Hello world');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello world' });
  });

  it('returns message array as-is', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ] as any;

    const result = convertInputToMessages(messages);

    expect(result).toEqual(messages);
  });

  it('extracts first array from nested arrays', () => {
    const messages = [
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
      [{ role: 'user', content: 'Bye' }],
    ] as any;

    const result = convertInputToMessages(messages);

    expect(result).toEqual(messages[0]);
  });

  it('converts PromptValue with toChatMessages', () => {
    const promptValue = {
      toChatMessages: () => [
        { role: 'user', content: 'From prompt' },
      ],
    } as any;

    const result = convertInputToMessages(promptValue);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'From prompt' });
  });

  it('returns empty array for unrecognized input', () => {
    const result = convertInputToMessages({} as any);
    expect(result).toEqual([]);
  });
});
