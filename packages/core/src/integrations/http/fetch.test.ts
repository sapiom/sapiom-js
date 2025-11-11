import { createSapiomClient, createSapiomFetch } from '../../fetch';
import { SapiomClient } from '../../lib/SapiomClient';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('createSapiomClient (from @sapiom/sdk/fetch)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env before each test
    process.env = { ...originalEnv };
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('initialization', () => {
    it('should create a fetch function with Sapiom tracking', () => {
      process.env.SAPIOM_API_KEY = 'test-key';

      const fetch = createSapiomFetch();

      expect(typeof fetch).toBe('function');
      expect((fetch as any).__sapiomClient).toBeInstanceOf(SapiomClient);
    });

    it('should work with createSapiomClient alias', () => {
      process.env.SAPIOM_API_KEY = 'test-key';

      const fetch = createSapiomClient();

      expect(typeof fetch).toBe('function');
      expect((fetch as any).__sapiomClient).toBeInstanceOf(SapiomClient);
    });

    it('should create fetch with provided sapiom config', () => {
      const fetch = createSapiomFetch({
        sapiom: {
          apiKey: 'config-key',
          baseURL: 'https://sapiom.example.com',
        },
      });

      expect(typeof fetch).toBe('function');

      // Verify SapiomClient was initialized correctly
      const sapiomClient = (fetch as any).__sapiomClient;
      expect(sapiomClient).toBeInstanceOf(SapiomClient);
      expect(sapiomClient.getHttpClient().defaults.baseURL).toBe('https://sapiom.example.com');
      expect(sapiomClient.getHttpClient().defaults.headers['x-api-key']).toBe('config-key');
    });

    it('should create fetch with existing SapiomClient instance', () => {
      const sapiomClient = new SapiomClient({
        apiKey: 'existing-key',
        baseURL: 'https://sapiom.example.com',
      });

      const fetch = createSapiomFetch({
        sapiomClient,
      });

      expect(typeof fetch).toBe('function');

      // Verify the provided SapiomClient is used
      expect((fetch as any).__sapiomClient).toBe(sapiomClient);
    });

    it('should create fetch from environment variables', () => {
      process.env.SAPIOM_API_KEY = 'env-key';
      process.env.SAPIOM_BASE_URL = 'https://sapiom-env.example.com';

      const fetch = createSapiomFetch();

      expect(typeof fetch).toBe('function');

      // Verify SapiomClient was initialized from environment
      const sapiomClient = (fetch as any).__sapiomClient;
      expect(sapiomClient).toBeInstanceOf(SapiomClient);
      expect(sapiomClient.getHttpClient().defaults.baseURL).toBe('https://sapiom-env.example.com');
      expect(sapiomClient.getHttpClient().defaults.headers['x-api-key']).toBe('env-key');
    });

    it('should throw error when no API key is available', () => {
      delete process.env.SAPIOM_API_KEY;

      expect(() => createSapiomFetch()).toThrow('SAPIOM_API_KEY environment variable is required');
    });
  });

  describe('fetch method - basic functionality', () => {
    let mockSapiomClient: SapiomClient;

    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
      mockSapiomClient = new SapiomClient({
        apiKey: 'test-key',
        baseURL: 'https://sapiom-mock.example.com',
      });
    });

    it('should make GET requests with string URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: jest.fn().mockResolvedValue(JSON.stringify({ message: 'success' })),
        json: jest.fn().mockResolvedValue({ message: 'success' }),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      const response = await fetch('https://api.example.com/test');

      expect(response).toBeDefined();
      expect(response.status).toBe(200);
    });

    it('should make POST requests with body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: jest.fn().mockResolvedValue(JSON.stringify({ id: '123' })),
        json: jest.fn().mockResolvedValue({ id: '123' }),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      const response = await fetch('https://api.example.com/users', {
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      });

      expect(response.status).toBe(201);
    });

    it('should accept URL object as input', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: jest.fn().mockResolvedValue(JSON.stringify({ ok: true })),
        json: jest.fn().mockResolvedValue({ ok: true }),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      const url = new URL('https://api.example.com/test');
      const response = await fetch(url);

      expect(response.status).toBe(200);
    });

    it('should handle Headers object in request init', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: jest.fn().mockResolvedValue(JSON.stringify({})),
        json: jest.fn().mockResolvedValue({}),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-Custom': 'value',
      });

      await fetch('https://api.example.com/test', { headers });

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle array headers in request init', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: jest.fn().mockResolvedValue(JSON.stringify({})),
        json: jest.fn().mockResolvedValue({}),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      const headers: [string, string][] = [
        ['Content-Type', 'application/json'],
        ['X-Custom', 'value'],
      ];

      await fetch('https://api.example.com/test', { headers });

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle plain object headers in request init', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: jest.fn().mockResolvedValue(JSON.stringify({})),
        json: jest.fn().mockResolvedValue({}),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      const headers = {
        'Content-Type': 'application/json',
        'X-Custom': 'value',
      };

      await fetch('https://api.example.com/test', { headers });

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('fetch method - HTTP methods', () => {
    let mockSapiomClient: SapiomClient;

    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
      mockSapiomClient = new SapiomClient({
        apiKey: 'test-key',
        baseURL: 'https://sapiom-mock.example.com',
      });
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: jest.fn().mockResolvedValue(JSON.stringify({})),
        json: jest.fn().mockResolvedValue({}),
      });
    });

    it('should default to GET method', async () => {
      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      await fetch('/test');

      // The adapter should have been called with GET method
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should support PUT method', async () => {
      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      await fetch('/resource/1', { method: 'PUT' });

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should support DELETE method', async () => {
      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      await fetch('/resource/1', { method: 'DELETE' });

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should support PATCH method', async () => {
      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      await fetch('/resource/1', { method: 'PATCH' });

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('configuration', () => {
    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
    });

    it('should accept authorization configuration', () => {
      const authConfig = {
        authorizedEndpoints: [
          {
            pathPattern: /^\/admin/,
            serviceName: 'admin-api',
          },
        ],
        onAuthorizationPending: jest.fn(),
      };

      const adapter = createSapiomFetch({
        authorization: authConfig,
      });

      expect(typeof adapter).toBe('function');
    });

    it('should accept payment configuration', () => {
      const paymentConfig = {
        onPaymentRequired: jest.fn(),
        onPaymentAuthorized: jest.fn(),
      };

      const adapter = createSapiomFetch({
        payment: paymentConfig,
      });

      expect(typeof adapter).toBe('function');
    });

    it('should allow disabling authorization', () => {
      const adapter = createSapiomFetch({
        authorization: {
          enabled: false,
        },
      });

      expect(typeof adapter).toBe('function');
    });

    it('should allow disabling payment handling', () => {
      const adapter = createSapiomFetch({
        payment: {
          enabled: false,
        },
      });

      expect(typeof adapter).toBe('function');
    });
  });

  describe('multiple instances', () => {
    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
    });

    it('should allow creating multiple fetch adapters', () => {
      const adapter1 = createSapiomFetch();
      const adapter2 = createSapiomFetch();

      expect(adapter1).not.toBe(adapter2);
      expect(typeof adapter1).toBe('function');
      expect(typeof adapter2).toBe('function');
    });

    it('should maintain separate configurations for each adapter', () => {
      const sapiomClient1 = new SapiomClient({
        apiKey: 'key1',
        baseURL: 'https://sapiom1.example.com',
      });
      const sapiomClient2 = new SapiomClient({
        apiKey: 'key2',
        baseURL: 'https://sapiom2.example.com',
      });

      const adapter1 = createSapiomFetch({
        sapiomClient: sapiomClient1,
      });
      const adapter2 = createSapiomFetch({
        sapiomClient: sapiomClient2,
      });

      expect((adapter1 as any).__adapter).not.toBe((adapter2 as any).__adapter);
      expect((adapter1 as any).__sapiomClient).toBe(sapiomClient1);
      expect((adapter2 as any).__sapiomClient).toBe(sapiomClient2);
    });
  });

  describe('configuration priority', () => {
    it('should prioritize sapiomClient over sapiom config', () => {
      const existingClient = new SapiomClient({
        apiKey: 'existing-key',
        baseURL: 'https://existing.example.com',
      });

      // Should not throw despite missing env
      delete process.env.SAPIOM_API_KEY;

      const adapter = createSapiomFetch({
        sapiomClient: existingClient,
        sapiom: {
          apiKey: 'config-key',
          baseURL: 'https://config.example.com',
        },
      });

      expect(typeof adapter).toBe('function');
    });

    it('should prioritize sapiom config over environment', () => {
      process.env.SAPIOM_API_KEY = 'env-key';
      process.env.SAPIOM_BASE_URL = 'https://env.example.com';

      const adapter = createSapiomFetch({
        sapiom: {
          apiKey: 'config-key',
          baseURL: 'https://config.example.com',
        },
      });

      expect(typeof adapter).toBe('function');
    });
  });

  describe('response data handling', () => {
    let mockSapiomClient: SapiomClient;

    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
      mockSapiomClient = new SapiomClient({
        apiKey: 'test-key',
        baseURL: 'https://sapiom-mock.example.com',
      });
    });

    it('should not double-encode JSON responses', async () => {
      const mockData = { message: 'success', count: 42 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: jest.fn().mockResolvedValue(JSON.stringify(mockData)),
        json: jest.fn().mockResolvedValue(mockData),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });

      const response = await fetch('https://api.example.com/test');
      const data = await response.json();

      // Should be parsed JSON, not double-encoded string
      expect(data).toEqual(mockData);
      expect(typeof data).toBe('object');
      expect(data.message).toBe('success');
      expect(data.count).toBe(42);
    });

    it('should not add extra quotes to text responses', async () => {
      const mockText = 'Hello, World!';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: jest.fn().mockResolvedValue(mockText),
        json: jest.fn().mockRejectedValue(new Error('Not JSON')),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });

      const response = await fetch('https://api.example.com/test');
      const text = await response.text();

      // Should be plain text, not wrapped in quotes
      expect(text).toBe(mockText);
      expect(text).not.toBe(`"${mockText}"`);
    });

    it('should handle boolean false correctly', async () => {
      const mockData = { success: false };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: jest.fn().mockResolvedValue(JSON.stringify(mockData)),
        json: jest.fn().mockResolvedValue(mockData),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });

      const response = await fetch('https://api.example.com/test');
      const data = await response.json();

      // false should not be converted to null
      expect(data.success).toBe(false);
      expect(data.success).not.toBe(null);
    });

    it('should handle number zero correctly', async () => {
      const mockData = { count: 0 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: jest.fn().mockResolvedValue(JSON.stringify(mockData)),
        json: jest.fn().mockResolvedValue(mockData),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });

      const response = await fetch('https://api.example.com/test');
      const data = await response.json();

      // 0 should not be converted to null
      expect(data.count).toBe(0);
      expect(data.count).not.toBe(null);
    });

    it('should handle empty string correctly', async () => {
      const mockText = '';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: jest.fn().mockResolvedValue(mockText),
        json: jest.fn().mockRejectedValue(new Error('Not JSON')),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });

      const response = await fetch('https://api.example.com/test');
      const text = await response.text();

      // Empty string should not be converted to null
      expect(text).toBe('');
      expect(text).not.toBe(null);
    });

    it('should handle null/undefined response correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: jest.fn().mockResolvedValue(''),
        json: jest.fn().mockResolvedValue(null),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });

      const response = await fetch('https://api.example.com/test');
      const text = await response.text();

      // null/undefined data should result in empty body
      expect(text).toBe('');
      expect(response.status).toBe(200);
    });

    it('should handle complex nested JSON objects', async () => {
      const mockData = {
        user: {
          name: 'John',
          scores: [0, 10, 20],
          active: false,
        },
        metadata: {
          empty: '',
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: jest.fn().mockResolvedValue(JSON.stringify(mockData)),
        json: jest.fn().mockResolvedValue(mockData),
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });

      const response = await fetch('https://api.example.com/test');
      const data = await response.json();

      // Complex structures should be preserved exactly
      expect(data).toEqual(mockData);
      expect(data.user.scores).toEqual([0, 10, 20]);
      expect(data.user.active).toBe(false);
      expect(data.metadata.empty).toBe('');
    });
  });
});
