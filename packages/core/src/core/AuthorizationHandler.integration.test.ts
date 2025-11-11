/**
 * Integration tests for AuthorizationHandler with real HTTP adapters
 * Tests the complete authorization flow with Axios, Fetch, and Node HTTP
 */
import fetchMock from '@fetch-mock/jest';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import nock from 'nock';

import { createAxiosAdapter } from '../http/adapters/axios';
import { createFetchAdapter } from '../http/adapters/fetch';
import { createNodeHttpAdapter } from '../http/adapters/node-http';
import { SapiomClient } from '../lib/SapiomClient';
import { TransactionAPI } from '../lib/TransactionAPI';
import { TransactionStatus } from '../types/transaction';
import { AuthorizationDeniedError } from './AuthorizationHandler';
import { withAuthorizationHandling } from './wrappers';

describe('AuthorizationHandler Integration Tests', () => {
  let mockTransactionAPI: jest.Mocked<TransactionAPI>;
  let mockSapiomClient: SapiomClient;

  beforeEach(() => {
    mockTransactionAPI = {
      create: jest.fn(),
      get: jest.fn(),
      reauthorizeWithPayment: jest.fn(),
      list: jest.fn(),
      isAuthorized: jest.fn(),
      isCompleted: jest.fn(),
      requiresPayment: jest.fn(),
      getPaymentDetails: jest.fn(),
    } as any;

    mockSapiomClient = {
      transactions: mockTransactionAPI,
    } as any;
  });

  describe('Axios Integration', () => {
    it('should authorize request and add transaction ID header', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
      const mockAxios = new MockAdapter(axiosInstance);
      const adapter = createAxiosAdapter(axiosInstance);

      const authCallbacks = {
        onAuthorizationPending: jest.fn(),
        onAuthorizationSuccess: jest.fn(),
      };

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: 'admin-api',
          },
        ],
        ...authCallbacks,
      });

      // Mock successful response
      mockAxios.onGet('/api/admin/users').reply((config) => {
        // Verify authorization header was added
        if (config.headers?.['X-Sapiom-Transaction-Id'] === 'tx_axios_auth') {
          return [200, { users: ['alice', 'bob'] }];
        }
        return [403, { error: 'Unauthorized' }];
      });

      // Mock immediate authorization
      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_axios_auth',
        status: TransactionStatus.AUTHORIZED,
      } as any);

      const response = await axiosInstance.get('/api/admin/users');

      expect(response.data).toEqual({ users: ['alice', 'bob'] });
      expect(authCallbacks.onAuthorizationSuccess).toHaveBeenCalledWith('tx_axios_auth', '/api/admin/users');

      mockAxios.restore();
    });

    it('should throw AuthorizationDeniedError for denied transactions', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
      const mockAxios = new MockAdapter(axiosInstance);
      const adapter = createAxiosAdapter(axiosInstance);

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: 'admin-api',
          },
        ],
      });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_denied',
        status: TransactionStatus.DENIED,
      } as any);

      await expect(axiosInstance.get('/api/admin/users')).rejects.toThrow(AuthorizationDeniedError);

      mockAxios.restore();
    });

    it('should skip authorization for non-matching endpoints', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
      const mockAxios = new MockAdapter(axiosInstance);
      const adapter = createAxiosAdapter(axiosInstance);

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: 'admin-api',
          },
        ],
      });

      mockAxios.onGet('/api/public/data').reply(200, { public: 'data' });

      const response = await axiosInstance.get('/api/public/data');

      expect(response.data).toEqual({ public: 'data' });
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();

      mockAxios.restore();
    });
  });

  describe('Fetch Integration', () => {
    beforeAll(() => {
      fetchMock.mockGlobal();
    });

    afterAll(() => {
      fetchMock.unmockGlobal();
    });

    afterEach(() => {
      fetchMock.removeRoutes();
    });

    it('should authorize request and add transaction ID header', async () => {
      const adapter = createFetchAdapter('https://api.example.com');

      const authCallbacks = {
        onAuthorizationSuccess: jest.fn(),
      };

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/sensitive\//,
            serviceName: 'sensitive-api',
          },
        ],
        ...authCallbacks,
      });

      fetchMock.route('https://api.example.com/api/sensitive/data', {
        status: 200,
        body: { sensitive: 'data' },
      });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_fetch_auth',
        status: TransactionStatus.AUTHORIZED,
      } as any);

      const response = await adapter.request({
        method: 'GET',
        url: '/api/sensitive/data',
        headers: {},
      });

      expect(response.data).toEqual({ sensitive: 'data' });
      expect(authCallbacks.onAuthorizationSuccess).toHaveBeenCalledWith('tx_fetch_auth', '/api/sensitive/data');

      // Verify header was added
      const calls = fetchMock.callHistory.calls();
      expect(calls[0]!.options!.headers!['x-sapiom-transaction-id']).toBe('tx_fetch_auth');
    });

    it('should authorize ALL requests when no patterns configured', async () => {
      const adapter = createFetchAdapter('https://api.example.com');

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        // No authorizedEndpoints - should authorize everything
      });

      fetchMock.route('https://api.example.com/any/endpoint', {
        status: 200,
        body: { authorized: true },
      });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_all',
        status: TransactionStatus.AUTHORIZED,
      } as any);

      const response = await adapter.request({
        method: 'POST',
        url: '/any/endpoint',
        headers: {},
        body: { test: 'data' },
      });

      expect(response.data).toEqual({ authorized: true });
      expect(mockTransactionAPI.create).toHaveBeenCalled();
    });
  });

  describe('Node HTTP Integration', () => {
    afterEach(() => {
      nock.cleanAll();
    });

    it('should authorize request and add transaction ID header', async () => {
      const adapter = createNodeHttpAdapter();

      const authCallbacks = {
        onAuthorizationSuccess: jest.fn(),
      };

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        // Authorize all requests (no pattern)
        authorizedEndpoints: undefined,
        ...authCallbacks,
      });

      const baseURL = 'https://api.example.com';

      // Mock successful response
      nock(baseURL).get('/api/protected/resource').reply(200, { protected: 'resource' });

      // Mock immediate authorization
      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_node_auth',
        status: TransactionStatus.AUTHORIZED,
      } as any);

      const response = await adapter.request({
        method: 'GET',
        url: `${baseURL}/api/protected/resource`,
        headers: {},
      });

      expect(response.data).toEqual({ protected: 'resource' });
      expect(mockTransactionAPI.create).toHaveBeenCalled();
      expect(authCallbacks.onAuthorizationSuccess).toHaveBeenCalled();
    });
  });

  describe('Error Handling Across Adapters', () => {
    it('should handle non-authorized endpoints correctly (Axios)', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
      const mockAxios = new MockAdapter(axiosInstance);
      const adapter = createAxiosAdapter(axiosInstance);

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: 'admin-api',
          },
        ],
      });

      mockAxios.onGet('/api/public/info').reply(200, { info: 'public' });

      const response = await axiosInstance.get('/api/public/info');

      expect(response.data).toEqual({ info: 'public' });
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();

      mockAxios.restore();
    });

    it('should use __sapiom overrides to force authorization (Fetch)', async () => {
      fetchMock.mockGlobal();

      const adapter = createFetchAdapter('https://api.example.com');

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: 'admin-api',
          },
        ],
      });

      fetchMock.route('https://api.example.com/api/public/action', {
        status: 200,
        body: { authorized: 'via override' },
      });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_override',
        status: TransactionStatus.AUTHORIZED,
      } as any);

      // Endpoint doesn't match pattern, but __sapiom forces authorization
      const response = await adapter.request({
        method: 'POST',
        url: '/api/public/action',
        headers: {},
        __sapiom: {
          serviceName: 'custom-service',
          actionName: 'custom-action',
        },
      });

      expect(response.data).toEqual({ authorized: 'via override' });
      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'custom-service',
          actionName: 'custom-action',
        }),
      );

      fetchMock.removeRoutes();
      fetchMock.unmockGlobal();
    });

    it('should skip authorization with skipAuthorization flag (Node HTTP)', async () => {
      const adapter = createNodeHttpAdapter();

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        // Authorize everything
        authorizedEndpoints: undefined,
      });

      const baseURL = 'https://api.example.com';

      nock(baseURL).get('/api/public-status').reply(200, { status: 'ok' });

      const response = await adapter.request({
        method: 'GET',
        url: `${baseURL}/api/public-status`,
        headers: {},
        __sapiom: {
          skipAuthorization: true,
        },
      });

      expect(response.data).toEqual({ status: 'ok' });
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();

      nock.cleanAll();
    });
  });

  describe('Trace and Agent Support', () => {
    it('should pass traceExternalId through __sapiom metadata (Axios)', async () => {
      const mockAxios = new MockAdapter(axios);
      const adapter = createAxiosAdapter(axios);

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api/,
            serviceName: 'test-api',
          },
        ],
      });

      mockAxios.onGet('/api/data').reply(200, { result: 'ok' });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_trace_test',
        status: TransactionStatus.AUTHORIZED,
      } as any);

      await adapter.request({
        method: 'GET',
        url: '/api/data',
        headers: {},
        __sapiom: {
          traceExternalId: 'my-workflow-123',
        },
      });

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          traceExternalId: 'my-workflow-123',
        }),
      );

      mockAxios.restore();
    });

    it('should pass agentId through __sapiom metadata (Fetch)', async () => {
      fetchMock.mockGlobal();

      const adapter = createFetchAdapter('https://api.example.com');

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api/,
            serviceName: 'test-api',
          },
        ],
      });

      fetchMock.route('https://api.example.com/api/action', {
        status: 200,
        body: { result: 'ok' },
      });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_agent_test',
        status: TransactionStatus.AUTHORIZED,
      } as any);

      await adapter.request({
        method: 'POST',
        url: '/api/action',
        headers: {},
        __sapiom: {
          agentId: 'AG-001',
        },
      });

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'AG-001',
        }),
      );

      fetchMock.removeRoutes();
      fetchMock.unmockGlobal();
    });

    it('should pass agentName through __sapiom metadata (Node HTTP)', async () => {
      const adapter = createNodeHttpAdapter();

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api/,
            serviceName: 'test-api',
          },
        ],
      });

      const baseURL = 'https://api.example.com';

      nock(baseURL).post('/api/create').reply(200, { created: true });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_agent_name_test',
        status: TransactionStatus.AUTHORIZED,
      } as any);

      await adapter.request({
        method: 'POST',
        url: `${baseURL}/api/create`,
        headers: {},
        __sapiom: {
          agentName: 'support-bot',
        },
      });

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'support-bot',
        }),
      );

      nock.cleanAll();
    });

    it('should pass both trace and agent config together (Axios)', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
      const mockAxios = new MockAdapter(axiosInstance);
      const adapter = createAxiosAdapter(axiosInstance);

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api/,
            serviceName: 'test-api',
          },
        ],
      });

      mockAxios.onPost('/api/process').reply(200, { processed: true });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_combo_test',
        status: TransactionStatus.AUTHORIZED,
      } as any);

      await adapter.request({
        method: 'POST',
        url: '/api/process',
        headers: {},
        __sapiom: {
          traceExternalId: 'workflow-456',
          agentName: 'my-bot',
          serviceName: 'custom-service',
        },
      });

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          traceExternalId: 'workflow-456',
          agentName: 'my-bot',
          serviceName: 'custom-service',
        }),
      );

      mockAxios.restore();
    });
  });
});
