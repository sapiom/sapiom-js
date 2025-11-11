/**
 * Integration tests for PaymentHandler with real HTTP adapters
 * Tests the complete payment flow with Axios, Fetch, and Node HTTP
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
import { withPaymentHandling } from './wrappers';

describe('PaymentHandler Integration Tests', () => {
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
    it('should handle 402 error and retry with payment', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
      const mockAxios = new MockAdapter(axiosInstance);
      const adapter = createAxiosAdapter(axiosInstance);

      const paymentCallbacks = {
        onPaymentRequired: jest.fn(),
        onPaymentSuccess: jest.fn(),
      };

      withPaymentHandling(adapter, {
        sapiomClient: mockSapiomClient,
        ...paymentCallbacks,
      });

      // Mock 402 response
      mockAxios.onGet('/premium').replyOnce(402, {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base',
            maxAmountRequired: '10000000',
            resourceName: 'https://api.example.com/premium',
            payTo: '0x1234567890123456789012345678901234567890',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          },
        ],
      });

      // Mock successful retry with X-PAYMENT header
      mockAxios.onGet('/premium').reply((config) => {
        if (config.headers?.['X-PAYMENT'] === 'PAYMENT_PROOF') {
          return [200, { premium: 'content' }];
        }
        return [402, {}];
      });

      // Mock transaction creation and authorization
      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_axios',
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        payment: {
          authorizationPayload: 'PAYMENT_PROOF',
        },
      } as any);

      const response = await axiosInstance.get('/premium');

      expect(response.data).toEqual({ premium: 'content' });
      expect(paymentCallbacks.onPaymentSuccess).toHaveBeenCalledWith('tx_axios');

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

    it('should handle 402 error and retry with payment', async () => {
      const adapter = createFetchAdapter('https://api.example.com');

      const paymentCallbacks = {
        onPaymentRequired: jest.fn(),
        onPaymentSuccess: jest.fn(),
      };

      withPaymentHandling(adapter, {
        sapiomClient: mockSapiomClient,
        ...paymentCallbacks,
      });

      let requestCount = 0;
      fetchMock.route(
        'https://api.example.com/premium',
        () => {
          requestCount++;
          if (requestCount === 1) {
            // First request: 402
            return {
              status: 402,
              body: {
                x402Version: 1,
                accepts: [
                  {
                    scheme: 'exact',
                    network: 'base-sepolia',
                    maxAmountRequired: '5000000',
                    resourceName: 'https://api.example.com/premium',
                    payTo: '0xabc',
                    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                  },
                ],
              },
            };
          }
          // Second request (retry): 200
          return {
            status: 200,
            body: { fetch: 'data' },
          };
        },
        { repeat: 2 },
      );

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_fetch',
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        payment: {
          authorizationPayload: 'FETCH_PAYMENT_PROOF',
        },
      } as any);

      const response = await adapter.request({
        method: 'GET',
        url: '/premium',
        headers: {},
      });

      expect(response.data).toEqual({ fetch: 'data' });
      expect(requestCount).toBe(2); // Verify retry happened
      expect(paymentCallbacks.onPaymentSuccess).toHaveBeenCalledWith('tx_fetch');

      // Verify X-PAYMENT header was added in retry
      const calls = fetchMock.callHistory.calls();
      expect(calls.length).toBe(2);
      expect(calls[0]!.options!.headers!['x-payment']).toBeUndefined();
      expect(calls[0]!.response!.status).toBe(402);
      expect(calls[1]!.options!.headers!['x-payment']).toBe('FETCH_PAYMENT_PROOF');
      expect(calls[1]!.response!.status).toBe(200);
    });
  });

  describe('Node HTTP Integration', () => {
    afterEach(() => {
      nock.cleanAll();
    });

    it('should handle 402 error and retry with payment', async () => {
      const adapter = createNodeHttpAdapter();

      const paymentCallbacks = {
        onPaymentRequired: jest.fn(),
        onPaymentSuccess: jest.fn(),
      };

      withPaymentHandling(adapter, {
        sapiomClient: mockSapiomClient,
        ...paymentCallbacks,
      });

      const baseURL = 'https://api.example.com';

      // Mock 402 response
      nock(baseURL)
        .get('/premium')
        .reply(402, {
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network: 'base',
              maxAmountRequired: '8000000',
              resource: `${baseURL}/premium`,
              payTo: '0xdef',
              asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            },
          ],
        });

      // Mock successful retry with X-PAYMENT header
      nock(baseURL).get('/premium').matchHeader('X-PAYMENT', 'NODE_PAYMENT_PROOF').reply(200, { node: 'data' });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_node',
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        payment: {
          authorizationPayload: 'NODE_PAYMENT_PROOF',
        },
      } as any);

      const response = await adapter.request({
        method: 'GET',
        url: `${baseURL}/premium`,
        headers: {},
      });

      expect(response.data).toEqual({ node: 'data' });
      expect(paymentCallbacks.onPaymentSuccess).toHaveBeenCalledWith('tx_node');
    });
  });

  describe('Error Handling Across Adapters', () => {
    it('should handle non-payment errors correctly (Axios)', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
      const mockAxios = new MockAdapter(axiosInstance);
      const adapter = createAxiosAdapter(axiosInstance);

      withPaymentHandling(adapter, {
        sapiomClient: mockSapiomClient,
      });

      mockAxios.onGet('/error').reply(500, { error: 'Server error' });

      await expect(axiosInstance.get('/error')).rejects.toMatchObject({
        status: 500,
      });

      // Should not attempt payment handling
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();

      mockAxios.restore();
    });

    it('should prevent retry loops (Fetch)', async () => {
      fetchMock.mockGlobal();

      const adapter = createFetchAdapter('https://api.example.com');

      withPaymentHandling(adapter, {
        sapiomClient: mockSapiomClient,
      });

      // Always return 402
      fetchMock.route(
        'https://api.example.com/premium',
        {
          status: 402,
          body: {
            requiresPayment: true,
            paymentData: {
              protocol: 'x402',
              network: 'base',
              token: 'USDC',
              scheme: 'exact',
              amount: '1000000',
              payTo: '0x123',
              payToType: 'address',
            },
          },
        },
        { repeat: 2 },
      );

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_loop',
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        payment: {
          authorizationPayload: 'PROOF',
        },
      } as any);

      await expect(
        adapter.request({
          method: 'GET',
          url: '/premium',
          headers: {},
        }),
      ).rejects.toMatchObject({
        status: 402,
      });

      // Should only create transaction once (retry returns 402 again but has __is402Retry flag)
      expect(mockTransactionAPI.create).toHaveBeenCalledTimes(1);

      fetchMock.removeRoutes();
      fetchMock.unmockGlobal();
    });
  });

  describe('Trace and Agent Support', () => {
    beforeAll(() => {
      fetchMock.mockGlobal();
    });

    afterAll(() => {
      fetchMock.unmockGlobal();
    });

    afterEach(() => {
      fetchMock.removeRoutes();
      nock.cleanAll();
    });

    it('should pass traceExternalId through __sapiom metadata on 402 (Axios)', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
      const mockAxios = new MockAdapter(axiosInstance);
      const adapter = createAxiosAdapter(axiosInstance);

      withPaymentHandling(adapter, {
        sapiomClient: mockSapiomClient,
      });

      // First request returns 402
      mockAxios.onGet('/premium').replyOnce(402, {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '1000000',
            resourceName: 'https://api.example.com/premium',
            payTo: '0x123',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
        ],
      });

      // Retry returns 200
      mockAxios.onGet('/premium').replyOnce(200, { data: 'premium content' });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_payment_trace',
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        payment: {
          authorizationPayload: 'PROOF',
        },
      } as any);

      await adapter.request({
        method: 'GET',
        url: '/premium',
        headers: {},
        __sapiom: {
          traceExternalId: 'payment-workflow-789',
        },
      });

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          traceExternalId: 'payment-workflow-789',
        }),
      );

      mockAxios.restore();
    });

    it('should pass agentId through __sapiom metadata on 402 (Fetch)', async () => {
      const adapter = createFetchAdapter('https://api.example.com');

      withPaymentHandling(adapter, {
        sapiomClient: mockSapiomClient,
      });

      let requestCount = 0;
      fetchMock.route(
        'https://api.example.com/premium',
        () => {
          requestCount++;
          if (requestCount === 1) {
            // First request: 402
            return {
              status: 402,
              body: {
                x402Version: 1,
                accepts: [
                  {
                    scheme: 'exact',
                    network: 'base-sepolia',
                    maxAmountRequired: '1000000',
                    resourceName: 'https://api.example.com/premium',
                    payTo: '0x123',
                    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                  },
                ],
              },
            };
          }
          // Second request (retry): 200
          return {
            status: 200,
            body: { data: 'premium content' },
          };
        },
        { repeat: 2 },
      );

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_payment_agent',
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        payment: {
          authorizationPayload: 'PROOF',
        },
      } as any);

      await adapter.request({
        method: 'GET',
        url: '/premium',
        headers: {},
        __sapiom: {
          agentId: 'AG-042',
        },
      });

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'AG-042',
        }),
      );
    });

    it('should pass agentName through __sapiom metadata on 402 (Node HTTP)', async () => {
      const adapter = createNodeHttpAdapter();

      withPaymentHandling(adapter, {
        sapiomClient: mockSapiomClient,
      });

      const baseURL = 'https://api.example.com';

      // First request returns 402
      nock(baseURL)
        .get('/premium')
        .reply(402, {
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network: 'base-sepolia',
              maxAmountRequired: '1000000',
              resourceName: 'https://api.example.com/premium',
              payTo: '0x123',
              asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            },
          ],
        });

      // Retry with payment proof returns 200
      nock(baseURL).get('/premium').matchHeader('x-payment', 'PROOF').reply(200, { data: 'premium content' });

      mockTransactionAPI.create.mockResolvedValue({
        id: 'tx_payment_agent_name',
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        payment: {
          authorizationPayload: 'PROOF',
        },
      } as any);

      await adapter.request({
        method: 'GET',
        url: `${baseURL}/premium`,
        headers: {},
        __sapiom: {
          agentName: 'payment-bot',
        },
      });

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'payment-bot',
        }),
      );

      nock.cleanAll();
    });
  });
});
