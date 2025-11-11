/**
 * Tests for service and resource inference
 */

import { inferServiceFromModel, getModelName, inferServiceFromMCPUrl } from './service-inference';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

describe('inferServiceFromModel', () => {
  it('detects OpenAI models', () => {
    const model = {
      constructor: { name: 'ChatOpenAI' },
    } as any as BaseChatModel;

    expect(inferServiceFromModel(model)).toBe('openai');
  });

  it('detects Anthropic models', () => {
    const model1 = {
      constructor: { name: 'ChatAnthropic' },
    } as any as BaseChatModel;

    expect(inferServiceFromModel(model1)).toBe('anthropic');

    const model2 = {
      constructor: { name: 'ChatClaude' },
    } as any as BaseChatModel;

    expect(inferServiceFromModel(model2)).toBe('anthropic');
  });

  it('detects Google models', () => {
    const model1 = {
      constructor: { name: 'ChatGoogle' },
    } as any as BaseChatModel;

    expect(inferServiceFromModel(model1)).toBe('google');

    const model2 = {
      constructor: { name: 'ChatGemini' },
    } as any as BaseChatModel;

    expect(inferServiceFromModel(model2)).toBe('google');
  });

  it('detects Cohere models', () => {
    const model = {
      constructor: { name: 'ChatCohere' },
    } as any as BaseChatModel;

    expect(inferServiceFromModel(model)).toBe('cohere');
  });

  it('detects Mistral models', () => {
    const model = {
      constructor: { name: 'ChatMistralAI' },
    } as any as BaseChatModel;

    expect(inferServiceFromModel(model)).toBe('mistral');
  });

  it('detects Groq models', () => {
    const model = {
      constructor: { name: 'ChatGroq' },
    } as any as BaseChatModel;

    expect(inferServiceFromModel(model)).toBe('groq');
  });

  it('returns llm-unknown for unrecognized models', () => {
    const model = {
      constructor: { name: 'CustomChatModel' },
    } as any as BaseChatModel;

    expect(inferServiceFromModel(model)).toBe('llm-unknown');
  });

  it('handles case-sensitive matching', () => {
    const model = {
      constructor: { name: 'chatOpenAI' }, // lowercase 'chat'
    } as any as BaseChatModel;

    expect(inferServiceFromModel(model)).toBe('openai');
  });
});

describe('getModelName', () => {
  it('extracts from modelName property', () => {
    const model = {
      modelName: 'gpt-4-turbo',
    } as any as BaseChatModel;

    expect(getModelName(model)).toBe('gpt-4-turbo');
  });

  it('extracts from model property', () => {
    const model = {
      model: 'claude-3-opus',
    } as any as BaseChatModel;

    expect(getModelName(model)).toBe('claude-3-opus');
  });

  it('falls back to _llmType() method', () => {
    const model = {
      _llmType: () => 'openai',
    } as any as BaseChatModel;

    expect(getModelName(model)).toBe('openai');
  });

  it('returns unknown-model if all methods fail', () => {
    const model = {} as any as BaseChatModel;

    expect(getModelName(model)).toBe('unknown-model');
  });

  it('prefers modelName over model property', () => {
    const model = {
      modelName: 'gpt-4',
      model: 'gpt-3.5-turbo',
    } as any as BaseChatModel;

    expect(getModelName(model)).toBe('gpt-4');
  });

  it('prefers model property over _llmType', () => {
    const model = {
      model: 'gpt-4',
      _llmType: () => 'fallback',
    } as any as BaseChatModel;

    expect(getModelName(model)).toBe('gpt-4');
  });
});

describe('inferServiceFromMCPUrl', () => {
  it('extracts hostname from URL', () => {
    const service = inferServiceFromMCPUrl('https://weather-api.example.com/mcp', 'weather');

    expect(service).toBe('mcp-weather-api.example.com');
  });

  it('handles different URL schemes', () => {
    const service1 = inferServiceFromMCPUrl('http://api.example.com', 'test');
    expect(service1).toBe('mcp-api.example.com');

    const service2 = inferServiceFromMCPUrl('https://secure.example.com', 'test');
    expect(service2).toBe('mcp-secure.example.com');
  });

  it('returns local service name when URL not provided', () => {
    const service = inferServiceFromMCPUrl(undefined, 'weather');

    expect(service).toBe('mcp-local-weather');
  });

  it('returns local service name for invalid URL', () => {
    const service = inferServiceFromMCPUrl('not-a-url', 'custom');

    expect(service).toBe('mcp-custom');
  });

  it('handles URL with port', () => {
    const service = inferServiceFromMCPUrl('https://api.example.com:8080/mcp', 'test');

    expect(service).toBe('mcp-api.example.com');
  });

  it('handles URL with path', () => {
    const service = inferServiceFromMCPUrl('https://api.example.com/v1/mcp/endpoint', 'test');

    expect(service).toBe('mcp-api.example.com');
  });

  it('handles localhost URLs', () => {
    const service = inferServiceFromMCPUrl('http://localhost:3000', 'local');

    expect(service).toBe('mcp-localhost');
  });
});
