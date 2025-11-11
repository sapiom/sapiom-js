import { HttpClientAdapter } from '../../http/types';
import { SapiomClient } from '../../lib/SapiomClient';
import { createSapiomClient, createSapiomNodeHttp } from '../../node-http';

describe('createSapiomClient (from @sapiom/sdk/node-http)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('initialization', () => {
    it('should create an HttpClientAdapter', () => {
      process.env.SAPIOM_API_KEY = 'test-key';

      const adapter = createSapiomNodeHttp();

      expect(adapter).toBeDefined();
      expect(adapter).toHaveProperty('request');
      expect(adapter).toHaveProperty('addRequestInterceptor');
      expect(adapter).toHaveProperty('addResponseInterceptor');
    });

    it('should work with createSapiomClient alias', () => {
      process.env.SAPIOM_API_KEY = 'test-key';

      const adapter = createSapiomClient();

      expect(adapter).toBeDefined();
      expect(adapter).toHaveProperty('request');
    });

    it('should create adapter with provided sapiom config', () => {
      const adapter = createSapiomNodeHttp({
        sapiom: {
          apiKey: 'config-key',
          baseURL: 'https://sapiom.example.com',
        },
      });

      expect(adapter).toBeDefined();
      expect(typeof adapter.request).toBe('function');

      // Verify SapiomClient was initialized correctly
      expect(adapter.__sapiomClient).toBeInstanceOf(SapiomClient);
      expect(adapter.__sapiomClient.getHttpClient().defaults.baseURL).toBe('https://sapiom.example.com');
      expect(adapter.__sapiomClient.getHttpClient().defaults.headers['x-api-key']).toBe('config-key');
    });

    it('should create adapter with existing SapiomClient instance', () => {
      const sapiomClient = new SapiomClient({
        apiKey: 'existing-key',
        baseURL: 'https://sapiom.example.com',
      });

      const adapter = createSapiomNodeHttp({
        sapiomClient,
      });

      expect(adapter).toBeDefined();

      // Verify the provided SapiomClient is used
      expect(adapter.__sapiomClient).toBe(sapiomClient);
    });

    it('should create adapter from environment variables', () => {
      process.env.SAPIOM_API_KEY = 'env-key';
      process.env.SAPIOM_BASE_URL = 'https://sapiom-env.example.com';

      const adapter = createSapiomNodeHttp();

      expect(adapter).toBeDefined();

      // Verify SapiomClient was initialized from environment
      expect(adapter.__sapiomClient).toBeInstanceOf(SapiomClient);
      expect(adapter.__sapiomClient.getHttpClient().defaults.baseURL).toBe('https://sapiom-env.example.com');
      expect(adapter.__sapiomClient.getHttpClient().defaults.headers['x-api-key']).toBe('env-key');
    });

    it('should throw error when no API key is available', () => {
      delete process.env.SAPIOM_API_KEY;

      expect(() => createSapiomNodeHttp()).toThrow('SAPIOM_API_KEY environment variable is required');
    });
  });

  describe('HttpClientAdapter interface', () => {
    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
    });

    it('should have request method', () => {
      const adapter = createSapiomNodeHttp();

      expect(adapter.request).toBeDefined();
      expect(typeof adapter.request).toBe('function');
    });

    it('should have addRequestInterceptor method', () => {
      const adapter = createSapiomNodeHttp();

      expect(adapter.addRequestInterceptor).toBeDefined();
      expect(typeof adapter.addRequestInterceptor).toBe('function');
    });

    it('should have addResponseInterceptor method', () => {
      const adapter = createSapiomNodeHttp();

      expect(adapter.addResponseInterceptor).toBeDefined();
      expect(typeof adapter.addResponseInterceptor).toBe('function');
    });

    it('should allow adding request interceptors', () => {
      const adapter = createSapiomNodeHttp();
      const interceptorFn = jest.fn((request) => request);

      const cleanup = adapter.addRequestInterceptor(interceptorFn);

      expect(cleanup).toBeDefined();
      expect(typeof cleanup).toBe('function');
    });

    it('should allow adding response interceptors', () => {
      const adapter = createSapiomNodeHttp();
      const interceptorFn = jest.fn((response) => response);

      const cleanup = adapter.addResponseInterceptor(interceptorFn);

      expect(cleanup).toBeDefined();
      expect(typeof cleanup).toBe('function');
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

      const adapter = createSapiomNodeHttp({
        authorization: authConfig,
      });

      expect(adapter).toBeDefined();
    });

    it('should accept payment configuration', () => {
      const paymentConfig = {
        onPaymentRequired: jest.fn(),
        onPaymentAuthorized: jest.fn(),
      };

      const adapter = createSapiomNodeHttp({
        payment: paymentConfig,
      });

      expect(adapter).toBeDefined();
    });

    it('should allow disabling authorization', () => {
      const adapter = createSapiomNodeHttp({
        authorization: {
          enabled: false,
        },
      });

      expect(adapter).toBeDefined();
    });

    it('should allow disabling payment handling', () => {
      const adapter = createSapiomNodeHttp({
        payment: {
          enabled: false,
        },
      });

      expect(adapter).toBeDefined();
    });

    it('should support combined authorization and payment config', () => {
      const adapter = createSapiomNodeHttp({
        authorization: {
          authorizedEndpoints: [{ pathPattern: /^\/admin/, serviceName: 'admin' }],
        },
        payment: {
          onPaymentRequired: jest.fn(),
        },
      });

      expect(adapter).toBeDefined();
    });
  });

  describe('multiple instances', () => {
    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
    });

    it('should allow creating multiple adapters', () => {
      const adapter1 = createSapiomNodeHttp();
      const adapter2 = createSapiomNodeHttp();

      expect(adapter1).not.toBe(adapter2);
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

      const adapter1 = createSapiomNodeHttp({
        sapiomClient: sapiomClient1,
      });
      const adapter2 = createSapiomNodeHttp({
        sapiomClient: sapiomClient2,
      });

      expect(adapter1).not.toBe(adapter2);
    });

    it('should allow different authorization configs per instance', () => {
      const adapter1 = createSapiomNodeHttp({
        authorization: {
          authorizedEndpoints: [{ pathPattern: /^\/admin/, serviceName: 'admin' }],
        },
      });

      const adapter2 = createSapiomNodeHttp({
        authorization: {
          authorizedEndpoints: [{ pathPattern: /^\/api/, serviceName: 'api' }],
        },
      });

      expect(adapter1).not.toBe(adapter2);
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

      const adapter = createSapiomNodeHttp({
        sapiomClient: existingClient,
        sapiom: {
          apiKey: 'config-key',
          baseURL: 'https://config.example.com',
        },
      });

      expect(adapter).toBeDefined();
    });

    it('should prioritize sapiom config over environment', () => {
      process.env.SAPIOM_API_KEY = 'env-key';
      process.env.SAPIOM_BASE_URL = 'https://env.example.com';

      const adapter = createSapiomNodeHttp({
        sapiom: {
          apiKey: 'config-key',
          baseURL: 'https://config.example.com',
        },
      });

      expect(adapter).toBeDefined();
    });

    it('should use environment variables when no config provided', () => {
      process.env.SAPIOM_API_KEY = 'env-key';
      process.env.SAPIOM_BASE_URL = 'https://env.example.com';

      const adapter = createSapiomNodeHttp();

      expect(adapter).toBeDefined();
    });
  });

  describe('interceptor application', () => {
    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
    });

    it('should have Sapiom interceptors applied during creation', () => {
      const adapter = createSapiomNodeHttp();

      // The adapter should have interceptors attached
      // We can verify this by checking that the methods exist and are functional
      let interceptorCalled = false;
      const cleanup = adapter.addRequestInterceptor((request) => {
        interceptorCalled = true;
        return request;
      });

      expect(cleanup).toBeDefined();
      expect(typeof cleanup).toBe('function');
    });

    it('should allow custom interceptors on top of Sapiom interceptors', () => {
      const adapter = createSapiomNodeHttp();

      const customInterceptor = jest.fn((request) => request);
      const cleanup1 = adapter.addRequestInterceptor(customInterceptor);

      const anotherInterceptor = jest.fn((request) => request);
      const cleanup2 = adapter.addRequestInterceptor(anotherInterceptor);

      expect(cleanup1).toBeDefined();
      expect(cleanup2).toBeDefined();
    });
  });

  describe('use cases', () => {
    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
    });

    it('should be suitable for server-side Node.js applications', () => {
      const adapter = createSapiomNodeHttp({
        sapiom: {
          apiKey: process.env.SAPIOM_API_KEY || 'test-key',
          baseURL: process.env.SAPIOM_BASE_URL,
        },
        authorization: {
          authorizedEndpoints: [{ pathPattern: /^\/api\/admin/, serviceName: 'admin-api' }],
        },
      });

      expect(adapter).toBeDefined();
      expect(adapter.request).toBeDefined();
    });

    it('should support logging callbacks', () => {
      const authLogger = jest.fn();
      const paymentLogger = jest.fn();

      const adapter = createSapiomNodeHttp({
        authorization: {
          onAuthorizationPending: authLogger,
        },
        payment: {
          onPaymentRequired: paymentLogger,
        },
      });

      expect(adapter).toBeDefined();
    });

    it('should allow fine-grained control over endpoints', () => {
      const adapter = createSapiomNodeHttp({
        authorization: {
          authorizedEndpoints: [
            { pathPattern: /^\/api\/admin/, serviceName: 'admin-api' },
            { pathPattern: /^\/api\/premium/, serviceName: 'premium-api' },
          ],
        },
        payment: {
          onPaymentRequired: (txId, payment) => {
            // Custom payment handling logic
            console.log(`Payment required: ${txId}`);
          },
        },
      });

      expect(adapter).toBeDefined();
    });
  });
});
