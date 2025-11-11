import axios, { AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { createSapiomAxios, createSapiomClient } from '../../axios';
import { SapiomClient } from '../../lib/SapiomClient';

describe('createSapiomClient (from @sapiom/sdk/axios)', () => {
  let axiosInstance: AxiosInstance;
  let mockAxios: MockAdapter;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env before each test
    process.env = { ...originalEnv };

    axiosInstance = axios.create({
      baseURL: 'https://api.example.com',
    });
    mockAxios = new MockAdapter(axiosInstance);
  });

  afterEach(() => {
    mockAxios.reset();
    process.env = originalEnv;
  });

  describe('initialization', () => {
    it('should wrap axios instance and return the same instance', () => {
      process.env.SAPIOM_API_KEY = 'test-key';

      const wrapped = createSapiomAxios(axiosInstance);

      expect(wrapped).toBe(axiosInstance);
    });

    it('should work with createSapiomClient alias', () => {
      process.env.SAPIOM_API_KEY = 'test-key';

      const wrapped = createSapiomClient(axiosInstance);

      expect(wrapped).toBe(axiosInstance);
    });

    it('should initialize with provided sapiom config', () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        sapiom: {
          apiKey: 'config-key',
          baseURL: 'https://sapiom.example.com',
        },
      });

      expect(wrapped).toBe(axiosInstance);

      // Verify SapiomClient was initialized correctly
      const sapiomClient = (wrapped as any).__sapiomClient;
      expect(sapiomClient).toBeInstanceOf(SapiomClient);
      expect(sapiomClient.getHttpClient().defaults.baseURL).toBe('https://sapiom.example.com');
      expect(sapiomClient.getHttpClient().defaults.headers['x-api-key']).toBe('config-key');
    });

    it('should initialize with existing SapiomClient instance', () => {
      const sapiomClient = new SapiomClient({
        apiKey: 'existing-key',
        baseURL: 'https://sapiom.example.com',
      });

      const wrapped = createSapiomAxios(axiosInstance, {
        sapiomClient,
      });

      expect(wrapped).toBe(axiosInstance);

      // Verify the provided SapiomClient is used
      expect((wrapped as any).__sapiomClient).toBe(sapiomClient);
    });

    it('should initialize from environment variables', () => {
      process.env.SAPIOM_API_KEY = 'env-key';
      process.env.SAPIOM_BASE_URL = 'https://sapiom-env.example.com';

      const wrapped = createSapiomAxios(axiosInstance);

      expect(wrapped).toBe(axiosInstance);

      // Verify SapiomClient was initialized from environment
      const sapiomClient = (wrapped as any).__sapiomClient;
      expect(sapiomClient).toBeInstanceOf(SapiomClient);
      expect(sapiomClient.getHttpClient().defaults.baseURL).toBe('https://sapiom-env.example.com');
      expect(sapiomClient.getHttpClient().defaults.headers['x-api-key']).toBe('env-key');
    });

    it('should throw error when no API key is available', () => {
      delete process.env.SAPIOM_API_KEY;

      expect(() => createSapiomAxios(axiosInstance)).toThrow('SAPIOM_API_KEY environment variable is required');
    });
  });

  describe('basic functionality', () => {
    let mockSapiomClient: SapiomClient;
    let mockSapiomAxios: MockAdapter;

    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';

      // Create mock Sapiom client to avoid real API calls
      mockSapiomClient = new SapiomClient({
        apiKey: 'test-key',
        baseURL: 'https://sapiom-mock.example.com',
      });
      mockSapiomAxios = new MockAdapter(mockSapiomClient.getHttpClient());

      // Mock Sapiom transaction creation to avoid 401 errors
      mockSapiomAxios.onPost('/transactions').reply(200, {
        id: 'mock-tx-id',
        status: 'authorized',
      });
    });

    afterEach(() => {
      mockSapiomAxios.reset();
    });

    it('should allow normal GET requests', async () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false }, // Disable to avoid transaction creation
        payment: { enabled: false },
      });
      mockAxios.onGet('/test').reply(200, { message: 'success' });

      const response = await wrapped.get('/test');

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ message: 'success' });
    });

    it('should allow normal POST requests', async () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      mockAxios.onPost('/users', { name: 'test' }).reply(201, { id: '123' });

      const response = await wrapped.post('/users', { name: 'test' });

      expect(response.status).toBe(201);
      expect(response.data).toEqual({ id: '123' });
    });

    it('should preserve all axios methods', async () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });

      mockAxios.onPut('/resource/1').reply(200, { updated: true });
      mockAxios.onDelete('/resource/2').reply(204);
      mockAxios.onPatch('/resource/3').reply(200, { patched: true });

      const putResponse = await wrapped.put('/resource/1', { data: 'new' });
      expect(putResponse.data).toEqual({ updated: true });

      const deleteResponse = await wrapped.delete('/resource/2');
      expect(deleteResponse.status).toBe(204);

      const patchResponse = await wrapped.patch('/resource/3', { field: 'value' });
      expect(patchResponse.data).toEqual({ patched: true });
    });

    it('should preserve axios instance configuration', async () => {
      const customInstance = axios.create({
        baseURL: 'https://custom.example.com',
        timeout: 5000,
        headers: {
          'X-Custom-Header': 'custom-value',
        },
      });
      const customMock = new MockAdapter(customInstance);

      const wrapped = createSapiomAxios(customInstance, {
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });

      customMock.onGet('/test').reply((config) => {
        expect(config.headers?.['X-Custom-Header']).toBe('custom-value');
        expect(config.timeout).toBe(5000);
        return [200, { ok: true }];
      });

      await wrapped.get('/test');
    });
  });

  describe('authorization configuration', () => {
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

      const wrapped = createSapiomAxios(axiosInstance, {
        authorization: authConfig,
      });

      expect(wrapped).toBe(axiosInstance);
    });

    it('should allow disabling authorization', () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        authorization: {
          enabled: false,
        },
      });

      expect(wrapped).toBe(axiosInstance);
    });
  });

  describe('payment configuration', () => {
    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
    });

    it('should accept payment configuration', () => {
      const paymentConfig = {
        onPaymentRequired: jest.fn(),
        onPaymentAuthorized: jest.fn(),
      };

      const wrapped = createSapiomAxios(axiosInstance, {
        payment: paymentConfig,
      });

      expect(wrapped).toBe(axiosInstance);
    });

    it('should allow disabling payment handling', () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        payment: {
          enabled: false,
        },
      });

      expect(wrapped).toBe(axiosInstance);
    });
  });

  describe('interceptors are applied', () => {
    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
    });

    it('should have request interceptors attached', () => {
      const wrapped = createSapiomAxios(axiosInstance);

      // Check if interceptors were added
      const requestInterceptorCount = (wrapped.interceptors.request as any).handlers.length;
      expect(requestInterceptorCount).toBeGreaterThan(0);
    });

    it('should have response interceptors attached', () => {
      const wrapped = createSapiomAxios(axiosInstance);

      // Check if interceptors were added
      const responseInterceptorCount = (wrapped.interceptors.response as any).handlers.length;
      expect(responseInterceptorCount).toBeGreaterThan(0);
    });
  });

  describe('error handling', () => {
    let mockSapiomClient: SapiomClient;

    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
      mockSapiomClient = new SapiomClient({
        apiKey: 'test-key',
        baseURL: 'https://sapiom-mock.example.com',
      });
    });

    it('should propagate non-payment errors normally', async () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      mockAxios.onGet('/notfound').reply(404, { error: 'Not found' });

      await expect(wrapped.get('/notfound')).rejects.toMatchObject({
        response: {
          status: 404,
        },
      });
    });

    it('should propagate 500 errors normally', async () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      mockAxios.onGet('/error').reply(500, { error: 'Server error' });

      await expect(wrapped.get('/error')).rejects.toMatchObject({
        response: {
          status: 500,
        },
      });
    });

    it('should handle network errors', async () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      mockAxios.onGet('/network-error').networkError();

      await expect(wrapped.get('/network-error')).rejects.toMatchObject({
        message: expect.stringContaining('Network Error'),
      });
    });
  });

  describe('integration with axios features', () => {
    let mockSapiomClient: SapiomClient;

    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
      mockSapiomClient = new SapiomClient({
        apiKey: 'test-key',
        baseURL: 'https://sapiom-mock.example.com',
      });
    });

    it('should work with axios request config', async () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      mockAxios.onGet('/test').reply((config) => {
        expect(config.headers?.['X-Custom']).toBe('value');
        expect(config.params).toEqual({ query: 'test' });
        return [200, { ok: true }];
      });

      await wrapped.get('/test', {
        headers: { 'X-Custom': 'value' },
        params: { query: 'test' },
      });
    });

    it('should work with axios response transformers', async () => {
      const customInstance = axios.create({
        baseURL: 'https://api.example.com',
        transformResponse: [
          (data) => {
            // Handle both string and object data
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;
            return { transformed: true, ...parsed };
          },
        ],
      });
      const customMock = new MockAdapter(customInstance);

      const wrapped = createSapiomAxios(customInstance, {
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      customMock.onGet('/test').reply(200, { original: true });

      const response = await wrapped.get('/test');
      expect(response.data).toEqual({
        transformed: true,
        original: true,
      });
    });

    it('should support axios CancelToken', async () => {
      const wrapped = createSapiomAxios(axiosInstance, {
        sapiomClient: mockSapiomClient,
        authorization: { enabled: false },
        payment: { enabled: false },
      });
      const CancelToken = axios.CancelToken;
      const source = CancelToken.source();

      mockAxios.onGet('/slow').reply(() => {
        // Delay to allow cancellation
        return new Promise((resolve) => {
          setTimeout(() => resolve([200, { data: 'slow response' }]), 100);
        });
      });

      const requestPromise = wrapped.get('/slow', {
        cancelToken: source.token,
      });

      // Cancel immediately
      source.cancel('Request cancelled by user');

      await expect(requestPromise).rejects.toMatchObject({
        message: 'Request cancelled by user',
      });
    });
  });

  describe('multiple instances', () => {
    beforeEach(() => {
      process.env.SAPIOM_API_KEY = 'test-key';
    });

    it('should allow creating multiple wrapped instances', () => {
      const instance1 = axios.create({ baseURL: 'https://api1.example.com' });
      const instance2 = axios.create({ baseURL: 'https://api2.example.com' });

      const wrapped1 = createSapiomAxios(instance1);
      const wrapped2 = createSapiomAxios(instance2);

      expect(wrapped1).toBe(instance1);
      expect(wrapped2).toBe(instance2);
      expect(wrapped1).not.toBe(wrapped2);
    });

    it('should maintain separate configurations for each instance', () => {
      const sapiomClient1 = new SapiomClient({
        apiKey: 'key1',
        baseURL: 'https://sapiom1.example.com',
      });
      const sapiomClient2 = new SapiomClient({
        apiKey: 'key2',
        baseURL: 'https://sapiom2.example.com',
      });

      const instance1 = axios.create({ baseURL: 'https://api1.example.com' });
      const instance2 = axios.create({ baseURL: 'https://api2.example.com' });

      const wrapped1 = createSapiomAxios(instance1, {
        sapiomClient: sapiomClient1,
      });
      const wrapped2 = createSapiomAxios(instance2, {
        sapiomClient: sapiomClient2,
      });

      expect(wrapped1).toBe(instance1);
      expect(wrapped2).toBe(instance2);
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

      const wrapped = createSapiomAxios(axiosInstance, {
        sapiomClient: existingClient,
        sapiom: {
          apiKey: 'config-key',
          baseURL: 'https://config.example.com',
        },
      });

      expect(wrapped).toBe(axiosInstance);
    });

    it('should prioritize sapiom config over environment', () => {
      process.env.SAPIOM_API_KEY = 'env-key';
      process.env.SAPIOM_BASE_URL = 'https://env.example.com';

      const wrapped = createSapiomAxios(axiosInstance, {
        sapiom: {
          apiKey: 'config-key',
          baseURL: 'https://config.example.com',
        },
      });

      expect(wrapped).toBe(axiosInstance);
    });
  });
});
