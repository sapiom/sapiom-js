/**
 * Tests for wrapSapiomAgent and createSapiomReactAgent
 */
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { SapiomClient } from '@sapiom/core';
import { wrapSapiomAgent, createSapiomReactAgent } from './agent';
import { SapiomChatOpenAI } from './models/openai';
import { SapiomChatAnthropic } from './models/anthropic';

// Mock @langchain/langgraph/prebuilt
jest.mock('@langchain/langgraph/prebuilt', () => ({
  createReactAgent: jest.fn().mockResolvedValue({
    invoke: jest.fn().mockResolvedValue({ messages: [] }),
    stream: jest.fn(),
  }),
}));

describe('wrapSapiomAgent', () => {
  let mockClient: SapiomClient;
  let mockGraph: any;
  let originalInvoke: jest.Mock;
  let originalStream: jest.Mock;
  let onAgentStart: jest.Mock;
  let onAgentEnd: jest.Mock;

  beforeEach(() => {
    onAgentStart = jest.fn();
    onAgentEnd = jest.fn();

    mockClient = {
      transactions: {
        create: jest.fn().mockResolvedValue({
          id: 'tx-agent-123',
          status: 'authorized',
          trace: { id: 'trace-uuid', externalId: 'test-trace' },
          serviceName: 'langchain-agent',
          actionName: 'invoke',
          resourceName: 'react',
        }),
        get: jest.fn().mockResolvedValue({
          id: 'tx-agent-123',
          status: 'authorized',
          trace: { id: 'trace-uuid', externalId: 'test-trace' },
          serviceName: 'langchain-agent',
          actionName: 'invoke',
          resourceName: 'react',
        }),
        addFacts: jest.fn().mockResolvedValue({
          success: true,
          factId: 'fact-123',
        }),
      },
    } as any;

    originalInvoke = jest.fn().mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Response' }],
    });

    originalStream = jest.fn().mockImplementation(async function* () {
      yield { messages: [{ role: 'assistant', content: 'Chunk' }] };
    });

    mockGraph = {
      invoke: originalInvoke,
      stream: originalStream,
    };
  });

  describe('invoke wrapper', () => {
    it('creates agent transaction with trace', async () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'agent-workflow',
        onAgentStart,
        onAgentEnd,
      });

      await agent.invoke({ messages: [{ role: 'user', content: 'Hello' }] });

      const createCall = (mockClient.transactions.create as jest.Mock).mock.calls[0][0];

      // Verify request facts sent
      expect(createCall.requestFacts).toBeDefined();
      expect(createCall.requestFacts.source).toBe('langchain-agent');
      expect(createCall.requestFacts.version).toBe('v1');
      expect(createCall.requestFacts.request.entryMethod).toBe('invoke');
      expect(createCall.traceExternalId).toBe('agent-workflow');
    });

    it('auto-generates traceId when not provided', async () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
      });

      await agent.invoke({ messages: [] });

      const createCall = (mockClient.transactions.create as jest.Mock).mock.calls[0][0];

      expect(createCall.requestFacts).toBeDefined();
      expect(createCall.traceExternalId).toMatch(/^sdk-[0-9a-f-]{36}$/);
    });

    it('injects trace metadata into config', async () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'test-trace',
      });

      let capturedConfig: any;
      originalInvoke.mockImplementation(async (state, config) => {
        capturedConfig = config;
        return { messages: [] };
      });

      await agent.invoke({ messages: [] });

      expect(capturedConfig.metadata.__sapiomTraceId).toBe('test-trace');
      expect(capturedConfig.metadata.__sapiomAgentTxId).toBe('tx-agent-123');
      expect(capturedConfig.metadata.__sapiomAgentInvokeTransaction).toBeDefined();
      expect(capturedConfig.metadata.__sapiomClient).toBe(mockClient);
    });

    it('calls onAgentStart callback', async () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'test-trace',
        onAgentStart,
      });

      await agent.invoke({ messages: [] });

      expect(onAgentStart).toHaveBeenCalledWith('test-trace', 'tx-agent-123');
    });

    it('calls onAgentEnd callback', async () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'test-trace',
        onAgentEnd,
      });

      await agent.invoke({ messages: [] });

      expect(onAgentEnd).toHaveBeenCalledWith('test-trace', 0);
    });

    it('preserves user-provided metadata', async () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'test-trace',
      });

      let capturedConfig: any;
      originalInvoke.mockImplementation(async (state, config) => {
        capturedConfig = config;
        return { messages: [] };
      });

      await agent.invoke(
        { messages: [] },
        {
          metadata: { userKey: 'userValue' },
        },
      );

      expect(capturedConfig.metadata.userKey).toBe('userValue');
      expect(capturedConfig.metadata.__sapiomTraceId).toBe('test-trace');
    });
  });

  describe('stream wrapper', () => {
    it('creates transaction when called directly', async () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'stream-trace',
        onAgentStart,
      });

      const stream = await agent.stream({ messages: [] });

      // Consume stream
      for await (const chunk of stream) {
        // Process chunk
      }

      const createCall = (mockClient.transactions.create as jest.Mock).mock.calls[0][0];

      // Verify request facts sent
      expect(createCall.requestFacts).toBeDefined();
      expect(createCall.requestFacts.source).toBe('langchain-agent');
      expect(createCall.requestFacts.request.entryMethod).toBe('stream');
      expect(createCall.traceExternalId).toBe('stream-trace');

      expect(onAgentStart).toHaveBeenCalledWith('stream-trace', 'tx-agent-123');
    });

    it('injects trace metadata into config', async () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'stream-trace',
      });

      let capturedConfig: any;
      originalStream.mockImplementation(async function* (state, config) {
        capturedConfig = config;
        yield { messages: [] };
      });

      const stream = await agent.stream({ messages: [] });
      for await (const chunk of stream) {
        // Consume
      }

      expect(capturedConfig.metadata.__sapiomTraceId).toBe('stream-trace');
      expect(capturedConfig.metadata.__sapiomClient).toBe(mockClient);
    });

    it('reuses transaction when called from invoke', async () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'test-trace',
      });

      // Mock invoke to call stream
      originalInvoke.mockImplementation(async (state, config) => {
        // Simulate LangChain's invoke calling stream
        const stream = await agent.stream(state, config);
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        return chunks[chunks.length - 1];
      });

      await agent.invoke({ messages: [] });

      // Should only create ONE transaction (for invoke)
      expect(mockClient.transactions.create).toHaveBeenCalledTimes(1);

      const createCall = (mockClient.transactions.create as jest.Mock).mock.calls[0][0];
      expect(createCall.requestFacts.request.entryMethod).toBe('invoke');
    });

    it('detects invoke transaction via metadata', async () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'test-trace',
      });

      let streamConfig: any;
      originalStream.mockImplementation(async function* (state, config) {
        streamConfig = config;
        yield { messages: [] };
      });

      // Simulate invoke calling stream with enriched config
      const invokeConfig = {
        metadata: {
          __sapiomAgentInvokeTransaction: { id: 'tx-from-invoke' },
          __sapiomTraceId: 'test-trace',
        },
      };

      const stream = await agent.stream({ messages: [] }, invokeConfig);
      for await (const chunk of stream) {
        // Consume
      }

      // Should NOT create new transaction (reuses from invoke)
      expect(mockClient.transactions.create).not.toHaveBeenCalled();

      // Should pass through config
      expect(streamConfig.metadata.__sapiomAgentInvokeTransaction).toBeDefined();
    });
  });

  describe('helper properties', () => {
    it('exposes __sapiomClient property', () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
      });

      expect(agent.__sapiomClient).toBe(mockClient);
    });

    it('exposes __sapiomTraceId property', () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'exposed-trace',
      });

      expect(agent.__sapiomTraceId).toBe('exposed-trace');
    });

    it('exposes auto-generated traceId', () => {
      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
      });

      expect(agent.__sapiomTraceId).toMatch(/^sdk-/);
    });
  });

  describe('error handling', () => {
    it('propagates authorization denied errors', async () => {
      (mockClient.transactions.get as jest.Mock).mockResolvedValue({
        id: 'tx-123',
        status: 'denied',
      });

      const agent = wrapSapiomAgent(mockGraph, {
        sapiomClient: mockClient,
        traceId: 'test-trace',
      });

      await expect(agent.invoke({ messages: [] })).rejects.toThrow();
    });
  });
});

describe('createSapiomReactAgent', () => {
  let mockClient: SapiomClient;
  let mockTools: any[];
  let mockPrompt: any;

  beforeEach(() => {
    mockClient = {
      transactions: {
        create: jest.fn().mockResolvedValue({
          id: 'tx-123',
          status: 'authorized',
          trace: { id: 'trace-uuid', externalId: 'test-trace' },
        }),
        get: jest.fn().mockResolvedValue({
          id: 'tx-123',
          status: 'authorized',
          trace: { id: 'trace-uuid', externalId: 'test-trace' },
        }),
      },
    } as any;

    mockTools = [
      {
        name: 'test-tool',
        description: 'A test tool',
        func: jest.fn(),
      },
    ];

    mockPrompt = {
      inputVariables: ['tools', 'tool_names', 'agent_scratchpad'],
      partial: jest.fn().mockResolvedValue({}),
    };

    // Reset mock from previous tests
    const { createReactAgent } = require('@langchain/langgraph/prebuilt');
    (createReactAgent as jest.Mock).mockClear();
    (createReactAgent as jest.Mock).mockResolvedValue({
      invoke: jest.fn().mockResolvedValue({ messages: [] }),
      stream: jest.fn(),
    });
  });

  it('wraps ChatOpenAI model with Sapiom tracking', async () => {
    const llm = new ChatOpenAI({ model: 'gpt-4', openAIApiKey: 'test-key' });

    const agent = await createSapiomReactAgent(
      { llm, tools: mockTools, prompt: mockPrompt },
      { sapiomClient: mockClient }
    );

    const { createReactAgent } = require('@langchain/langgraph/prebuilt');
    expect(createReactAgent).toHaveBeenCalled();

    const callArgs = (createReactAgent as jest.Mock).mock.calls[0][0];
    expect(callArgs.llm).toBeInstanceOf(SapiomChatOpenAI);
    expect(callArgs.llm.__sapiomWrapped).toBe(true);
  });

  it('wraps ChatAnthropic model with Sapiom tracking', async () => {
    const llm = new ChatAnthropic({
      model: 'claude-3-5-sonnet-20241022',
      anthropicApiKey: 'test-key',
    });

    const agent = await createSapiomReactAgent(
      { llm, tools: mockTools, prompt: mockPrompt },
      { sapiomClient: mockClient }
    );

    const { createReactAgent } = require('@langchain/langgraph/prebuilt');
    expect(createReactAgent).toHaveBeenCalled();

    const callArgs = (createReactAgent as jest.Mock).mock.calls[0][0];
    expect(callArgs.llm).toBeInstanceOf(SapiomChatAnthropic);
    expect(callArgs.llm.__sapiomWrapped).toBe(true);
  });

  it('does not double-wrap already wrapped models', async () => {
    const llm = new SapiomChatOpenAI(
      { model: 'gpt-4', openAIApiKey: 'test-key' },
      { sapiomClient: mockClient }
    );

    const agent = await createSapiomReactAgent(
      { llm, tools: mockTools, prompt: mockPrompt },
      { sapiomClient: mockClient }
    );

    const { createReactAgent } = require('@langchain/langgraph/prebuilt');
    const callArgs = (createReactAgent as jest.Mock).mock.calls[0][0];

    // Should be the same instance, not re-wrapped
    expect(callArgs.llm).toBe(llm);
  });

  it('wraps all tools with Sapiom tracking', async () => {
    const llm = new ChatOpenAI({ model: 'gpt-4', openAIApiKey: 'test-key' });

    await createSapiomReactAgent(
      { llm, tools: mockTools, prompt: mockPrompt },
      { sapiomClient: mockClient }
    );

    const { createReactAgent } = require('@langchain/langgraph/prebuilt');
    const callArgs = (createReactAgent as jest.Mock).mock.calls[0][0];

    // Tools should be wrapped
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].__sapiomWrapped).toBe(true);
  });

  it('does not double-wrap already wrapped tools', async () => {
    const llm = new ChatOpenAI({ model: 'gpt-4', openAIApiKey: 'test-key' });
    const wrappedTool = { ...mockTools[0], __sapiomWrapped: true };

    await createSapiomReactAgent(
      { llm, tools: [wrappedTool], prompt: mockPrompt },
      { sapiomClient: mockClient }
    );

    const { createReactAgent } = require('@langchain/langgraph/prebuilt');
    const callArgs = (createReactAgent as jest.Mock).mock.calls[0][0];

    // Should be the same instance
    expect(callArgs.tools[0]).toBe(wrappedTool);
  });

  it('wraps the agent graph with trace support', async () => {
    const llm = new ChatOpenAI({ model: 'gpt-4', openAIApiKey: 'test-key' });

    const agent = await createSapiomReactAgent(
      { llm, tools: mockTools, prompt: mockPrompt },
      {
        sapiomClient: mockClient,
        traceId: 'custom-trace',
      }
    );

    // Agent should have Sapiom properties
    expect(agent.__sapiomClient).toBe(mockClient);
    expect(agent.__sapiomTraceId).toBe('custom-trace');
  });

  it('passes through additional createReactAgent params', async () => {
    const llm = new ChatOpenAI({ model: 'gpt-4', openAIApiKey: 'test-key' });

    await createSapiomReactAgent(
      {
        llm,
        tools: mockTools,
        prompt: mockPrompt,
        streamRunnable: false,
        customParam: 'test',
      } as any,
      { sapiomClient: mockClient }
    );

    const { createReactAgent } = require('@langchain/langgraph/prebuilt');
    const callArgs = (createReactAgent as jest.Mock).mock.calls[0][0];

    expect(callArgs.streamRunnable).toBe(false);
    expect(callArgs.customParam).toBe('test');
  });

  it('throws error for unsupported model types', async () => {
    const unsupportedModel = {
      constructor: { name: 'UnsupportedModel' },
    } as any;

    await expect(
      createSapiomReactAgent(
        { llm: unsupportedModel, tools: mockTools, prompt: mockPrompt },
        { sapiomClient: mockClient }
      )
    ).rejects.toThrow('Unsupported model type: UnsupportedModel');
  });

  it('uses auto-generated trace if not provided', async () => {
    const llm = new ChatOpenAI({ model: 'gpt-4', openAIApiKey: 'test-key' });

    const agent = await createSapiomReactAgent(
      { llm, tools: mockTools, prompt: mockPrompt },
      { sapiomClient: mockClient }
    );

    // Should have auto-generated trace ID with sdk- prefix
    expect(agent.__sapiomTraceId).toMatch(/^sdk-/);
  });

  it('preserves trace from wrapped model if not explicitly provided', async () => {
    const llm = new SapiomChatOpenAI(
      { model: 'gpt-4', openAIApiKey: 'test-key' },
      { sapiomClient: mockClient, traceId: 'model-trace' }
    );

    const agent = await createSapiomReactAgent(
      { llm, tools: mockTools, prompt: mockPrompt },
      { sapiomClient: mockClient }
    );

    // Should use trace from model
    expect(agent.__sapiomTraceId).toBe('model-trace');
  });

  it('explicit traceId overrides model trace', async () => {
    const llm = new SapiomChatOpenAI(
      { model: 'gpt-4', openAIApiKey: 'test-key' },
      { sapiomClient: mockClient, traceId: 'model-trace' }
    );

    const agent = await createSapiomReactAgent(
      { llm, tools: mockTools, prompt: mockPrompt },
      { sapiomClient: mockClient, traceId: 'explicit-trace' }
    );

    // Explicit trace should take precedence
    expect(agent.__sapiomTraceId).toBe('explicit-trace');
  });
});
