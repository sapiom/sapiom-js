/**
 * Tests for LangChain tool wrappers
 */

import { DynamicStructuredTool, DynamicTool } from '@langchain/core/tools';
import { z } from 'zod';
import { wrapSapiomTool, createSapiomTool, sapiomTool, SapiomDynamicTool } from './tool';
import { SapiomClient } from '@sapiom/core';

describe('wrapSapiomTool', () => {
  let mockClient: SapiomClient;

  beforeEach(() => {
    mockClient = {
      transactions: {
        create: jest.fn().mockResolvedValue({
          id: 'tx-123',
          status: 'authorized',
          serviceName: 'tool',
          actionName: 'call',
          resourceName: 'test_tool',
        }),
        get: jest.fn().mockResolvedValue({ id: 'tx-123', status: 'authorized' }),
        addFacts: jest.fn().mockResolvedValue({
          success: true,
          factId: 'fact-123',
        }),
      },
    } as any;
  });

  it('wraps DynamicStructuredTool and tracks calls', async () => {
    const originalTool = new DynamicStructuredTool({
      name: 'test_tool',
      description: 'Test tool',
      schema: z.object({ input: z.string() }),
      func: async (input: any) => `Result: ${input.input}`,
    });

    const wrapped = wrapSapiomTool(originalTool, {
      sapiomClient: mockClient,
      serviceName: 'test-service',
      resourceName: 'test-resource',
    });

    // Execute tool
    const result = await (wrapped as any).func({ input: 'test' }, undefined, {
      metadata: { __sapiomTraceId: 'trace-123' },
    });

    expect(result).toBe('Result: test');

    const createCall = (mockClient.transactions.create as jest.Mock).mock.calls[0][0];

    // Verify request facts sent
    expect(createCall.requestFacts).toBeDefined();
    expect(createCall.requestFacts.source).toBe('langchain-tool');
    expect(createCall.requestFacts.request.toolName).toBe('test_tool');

    // Verify config overrides applied
    expect(createCall.serviceName).toBe('test-service');
    expect(createCall.resourceName).toBe('test-resource');

    expect(mockClient.transactions.get).toHaveBeenCalledWith('tx-123');

    // Verify response facts sent
    expect(mockClient.transactions.addFacts).toHaveBeenCalled();
  });

  it('prevents double-wrapping', () => {
    const originalTool = new DynamicStructuredTool({
      name: 'test_tool',
      description: 'Test',
      schema: z.object({}),
      func: async () => 'result',
    });

    const wrapped1 = wrapSapiomTool(originalTool, { sapiomClient: mockClient });
    const wrapped2 = wrapSapiomTool(wrapped1, { sapiomClient: mockClient });

    expect(wrapped1).toBe(wrapped2);
    expect((wrapped1 as any).__sapiomWrapped).toBe(true);
  });

  it('skips wrapping tools without func property', () => {
    const toolWithoutFunc = {
      name: 'custom_tool',
      description: 'Custom',
      invoke: async () => 'result',
    } as any;

    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const wrapped = wrapSapiomTool(toolWithoutFunc, { sapiomClient: mockClient });

    expect(wrapped).toBe(toolWithoutFunc);
    expect((wrapped as any).__sapiomWrapped).toBe(true);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("doesn't have 'func' property"),
    );

    consoleWarnSpy.mockRestore();
  });

  it('uses session client when available', async () => {
    const sessionClient = {
      transactions: {
        create: jest.fn().mockResolvedValue({
          id: 'tx-session-456',
          status: 'authorized',
          serviceName: 'tool',
          actionName: 'call',
          resourceName: 'test',
        }),
        get: jest.fn().mockResolvedValue({ id: 'tx-session-456', status: 'authorized' }),
        addFacts: jest.fn().mockResolvedValue({
          success: true,
          factId: 'fact-456',
        }),
      },
    } as any;

    const tool = new DynamicStructuredTool({
      name: 'test',
      description: 'Test',
      schema: z.object({}),
      func: async () => 'result',
    });

    const wrapped = wrapSapiomTool(tool, { sapiomClient: mockClient });

    await (wrapped as any).func({}, undefined, {
      metadata: {
        __sapiomSessionId: 'session-123',
        __sapiomClient: sessionClient,
      },
    });

    // Should use session client, not tool's client
    expect(sessionClient.transactions.create).toHaveBeenCalled();
    expect(mockClient.transactions.create).not.toHaveBeenCalled();
  });

  it('handles MCP payment errors and retries', async () => {
    const paymentError = {
      message: JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: 'exact', amount: '1000', unit: 'USD' }],
      }),
    };

    const authorizedPaymentTx = {
      id: 'tx-payment-789',
      status: 'authorized',
      payment: {
        authorizationPayload: 'payment-auth-token',
      },
    };

    let callCount = 0;
    const tool = new DynamicStructuredTool({
      name: 'paid_tool',
      description: 'Requires payment',
      schema: z.object({ data: z.string() }),
      func: async (args: any) => {
        callCount++;
        if (callCount === 1 && !args._meta?.['x402/payment']) {
          throw paymentError;
        }
        return 'Paid result';
      },
    });

    (mockClient.transactions.create as jest.Mock)
      .mockResolvedValueOnce({ id: 'tx-123' }) // Tool transaction
      .mockResolvedValueOnce({ id: 'tx-payment-789' }); // Payment transaction

    (mockClient.transactions.get as jest.Mock)
      .mockResolvedValueOnce({ id: 'tx-123', status: 'authorized' }) // Tool auth
      .mockResolvedValueOnce(authorizedPaymentTx); // Payment auth

    const wrapped = wrapSapiomTool(tool, { sapiomClient: mockClient });

    const result = await (wrapped as any).func({ data: 'test' }, undefined, {
      metadata: { __sapiomTraceId: 'trace-123' },
    });

    expect(result).toBe('Paid result');
    expect(callCount).toBe(2); // Called twice (first failed, retry succeeded)
    expect(mockClient.transactions.create).toHaveBeenCalledTimes(2);
  });

  it('calls onBeforeCall and onAfterCall callbacks', async () => {
    const onBeforeCall = jest.fn();
    const onAfterCall = jest.fn();

    const tool = new DynamicStructuredTool({
      name: 'test_tool',
      description: 'Test',
      schema: z.object({ input: z.string() }),
      func: async (input: any) => `Result: ${input.input}`,
    });

    const wrapped = wrapSapiomTool(tool, {
      sapiomClient: mockClient,
      onBeforeCall,
      onAfterCall,
    });

    const result = await (wrapped as any).func({ input: 'test' }, undefined, {
      metadata: { __sapiomTraceId: 'trace-123' },
    });

    expect(onBeforeCall).toHaveBeenCalledWith('tx-123', 'test_tool', { input: 'test' }, 'trace-123');
    expect(onAfterCall).toHaveBeenCalledWith('tx-123', 'Result: test');
  });
});

describe('SapiomDynamicTool', () => {
  let mockClient: SapiomClient;

  beforeEach(() => {
    mockClient = {
      transactions: {
        create: jest.fn().mockResolvedValue({
          id: 'tx-456',
          status: 'authorized',
          serviceName: 'tool',
          actionName: 'call',
          resourceName: 'weather',
        }),
        get: jest.fn().mockResolvedValue({ id: 'tx-456', status: 'authorized' }),
        addFacts: jest.fn().mockResolvedValue({
          success: true,
          factId: 'fact-456',
        }),
      },
    } as any;
  });

  it('creates tool with Sapiom tracking built-in', async () => {
    const tool = new SapiomDynamicTool(
      {
        name: 'weather',
        description: 'Get weather',
        schema: z.object({ city: z.string() }),
        func: async ({ city }) => `Weather in ${city}: Sunny`,
      },
      {
        sapiomClient: mockClient,
        serviceName: 'weather-api',
      },
    );

    expect(tool.__sapiomClient).toBe(mockClient);
    expect(tool.__sapiomWrapped).toBe(true);
    expect(tool).toBeInstanceOf(DynamicStructuredTool);
  });

  it('executes with authorization', async () => {
    const tool = new SapiomDynamicTool(
      {
        name: 'search',
        description: 'Search database',
        schema: z.object({ query: z.string() }),
        func: async ({ query }) => `Results for: ${query}`,
      },
      {
        sapiomClient: mockClient,
        serviceName: 'database',
        resourceName: 'search',
      },
    );

    // Access the wrapped func via _call (internal method)
    const result = await (tool as any)._call(
      { query: 'test' },
      undefined,
      { metadata: { __sapiomTraceId: 'trace-789' } },
    );

    expect(result).toBe('Results for: test');
    expect(mockClient.transactions.create).toHaveBeenCalledWith({
      serviceName: 'database',
      actionName: 'call',
      resourceName: 'search',
      traceExternalId: 'trace-789',
      qualifiers: {
        tool: 'search',
        // args NOT included for security
      },
    });
  });

  it('handles payment errors', async () => {
    const paymentError = {
      message: JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: 'exact', amount: '500' }],
      }),
    };

    const authorizedPaymentTx = {
      id: 'tx-payment-999',
      status: 'authorized',
      payment: {
        authorizationPayload: { token: 'pay-token' },
      },
    };

    let callCount = 0;
    const tool = new SapiomDynamicTool(
      {
        name: 'premium',
        description: 'Premium feature',
        schema: z.object({ data: z.string() }),
        func: async (args: any) => {
          callCount++;
          if (callCount === 1 && !args._meta?.['x402/payment']) {
            throw paymentError;
          }
          return 'Premium result';
        },
      },
      { sapiomClient: mockClient },
    );

    (mockClient.transactions.create as jest.Mock)
      .mockResolvedValueOnce({ id: 'tx-tool-111' })
      .mockResolvedValueOnce({ id: 'tx-payment-999' });

    (mockClient.transactions.get as jest.Mock)
      .mockResolvedValueOnce({ id: 'tx-tool-111', status: 'authorized' })
      .mockResolvedValueOnce(authorizedPaymentTx);

    const result = await (tool as any)._call({ data: 'test' }, undefined, {});

    expect(result).toBe('Premium result');
    expect(callCount).toBe(2);
  });
});

describe('sapiomTool', () => {
  let mockClient: SapiomClient;

  beforeEach(() => {
    mockClient = {
      transactions: {
        create: jest.fn().mockResolvedValue({
          id: 'tx-factory',
          status: 'authorized',
          serviceName: 'tool',
          actionName: 'call',
          resourceName: 'test',
        }),
        get: jest.fn().mockResolvedValue({ id: 'tx-factory', status: 'authorized' }),
        addFacts: jest.fn().mockResolvedValue({
          success: true,
          factId: 'fact-factory',
        }),
      },
    } as any;
  });

  it('creates SapiomDynamicTool instance', () => {
    const tool = sapiomTool(
      async ({ city }) => `Weather: ${city}`,
      {
        name: 'weather',
        description: 'Get weather',
        schema: z.object({ city: z.string() }),
      },
      {
        sapiomClient: mockClient,
        serviceName: 'weather-api',
      },
    );

    expect(tool).toBeInstanceOf(SapiomDynamicTool);
    expect(tool).toBeInstanceOf(DynamicStructuredTool);
    expect(tool.name).toBe('weather');
    expect(tool.__sapiomClient).toBe(mockClient);
  });

  it('works as drop-in replacement for tool()', async () => {
    const tool = sapiomTool(
      async ({ count }) => `Sent ${count} messages`,
      {
        name: 'send_sms',
        description: 'Send SMS messages',
        schema: z.object({ count: z.number() }),
      },
      { sapiomClient: mockClient },
    );

    const result = await (tool as any)._call({ count: 5 }, undefined, {});

    expect(result).toBe('Sent 5 messages');
    expect(mockClient.transactions.create).toHaveBeenCalled();
  });

  it('supports responseFormat option', () => {
    const tool = sapiomTool(
      async ({ input }) => ['content', { artifact: 'data' }] as any,
      {
        name: 'test',
        description: 'Test',
        schema: z.object({ input: z.string() }),
        responseFormat: 'content_and_artifact',
      },
      { sapiomClient: mockClient },
    );

    expect(tool.responseFormat).toBe('content_and_artifact');
  });

  it('supports returnDirect option', () => {
    const tool = sapiomTool(
      async ({ query }) => 'result',
      {
        name: 'final',
        description: 'Final result',
        schema: z.object({ query: z.string() }),
        returnDirect: true,
      },
      { sapiomClient: mockClient },
    );

    expect(tool.returnDirect).toBe(true);
  });
});

describe('createSapiomTool (backwards compatibility)', () => {
  it('is alias for wrapSapiomTool', () => {
    expect(createSapiomTool).toBe(wrapSapiomTool);
  });
});

describe('integration scenarios', () => {
  let mockClient: SapiomClient;

  beforeEach(() => {
    mockClient = {
      transactions: {
        create: jest.fn().mockResolvedValue({
          id: 'tx-integration',
          status: 'authorized',
          serviceName: 'tool',
          actionName: 'call',
          resourceName: 'weather',
        }),
        get: jest.fn().mockResolvedValue({ id: 'tx-integration', status: 'authorized' }),
        addFacts: jest.fn().mockResolvedValue({
          success: true,
          factId: 'fact-integration',
        }),
      },
    } as any;
  });

  it('wrapSapiomTool preserves tool functionality', async () => {
    let executionCount = 0;

    const tool = new DynamicStructuredTool({
      name: 'counter',
      description: 'Counts executions',
      schema: z.object({ increment: z.number() }),
      func: async (input: any) => { const { increment } = input;
        executionCount += increment;
        return `Count: ${executionCount}`;
      },
    });

    const wrapped = wrapSapiomTool(tool, { sapiomClient: mockClient });

    const result1 = await (wrapped as any).func({ increment: 5 }, undefined, {});
    const result2 = await (wrapped as any).func({ increment: 3 }, undefined, {});

    expect(result1).toBe('Count: 5');
    expect(result2).toBe('Count: 8');
    expect(executionCount).toBe(8);
  });

  it('sapiomTool creates clean non-mutated instances', () => {
    const tool1 = sapiomTool(
      async ({ input }) => `Result: ${input}`,
      {
        name: 'test',
        description: 'Test',
        schema: z.object({ input: z.string() }),
      },
      { sapiomClient: mockClient },
    );

    const tool2 = sapiomTool(
      async ({ input }) => `Different: ${input}`,
      {
        name: 'test',
        description: 'Test',
        schema: z.object({ input: z.string() }),
      },
      { sapiomClient: mockClient },
    );

    // Different instances
    expect(tool1).not.toBe(tool2);
    expect(tool1.__sapiomClient).toBe(mockClient);
    expect(tool2.__sapiomClient).toBe(mockClient);
  });

  it('both APIs work with trace metadata', async () => {
    const mutatedTool = wrapSapiomTool(
      new DynamicStructuredTool({
        name: 'mutated',
        description: 'Mutated',
        schema: z.object({}),
        func: async () => 'mutated-result',
      }),
      { sapiomClient: mockClient },
    );

    const cleanTool = sapiomTool(
      async () => 'clean-result',
      {
        name: 'clean',
        description: 'Clean',
        schema: z.object({}),
      },
      { sapiomClient: mockClient },
    );

    const traceMetadata = {
      metadata: {
        __sapiomTraceId: 'trace-test',
        __sapiomAgentTxId: 'tx-agent',
      },
    };

    await (mutatedTool as any).func({}, undefined, traceMetadata);
    await (cleanTool as any)._call({}, undefined, traceMetadata);

    // Both should create transactions with same trace
    const calls = (mockClient.transactions.create as jest.Mock).mock.calls;
    expect(calls[0][0].traceExternalId).toBe('trace-test');
    expect(calls[1][0].traceExternalId).toBe('trace-test');
  });
});
