/**
 * Integration tests for PaymentHandler with Fetch adapter
 * Tests the complete payment flow with Fetch HTTP client
 */
import fetchMock from '@fetch-mock/jest';

import { createFetchAdapter } from './adapter';
import { SapiomClient } from '@sapiom/core';
import { TransactionAPI } from '@sapiom/core';
import { TransactionStatus } from '@sapiom/core';
import { withPaymentHandling } from '@sapiom/core';

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
      expect((calls[0]!.options!.headers as any)['x-payment']).toBeUndefined();
      expect(calls[0]!.response!.status).toBe(402);
      expect((calls[1]!.options!.headers as any)['x-payment']).toBe('FETCH_PAYMENT_PROOF');
      expect(calls[1]!.response!.status).toBe(200);
    });
  });

  describe('Error Handling Across Adapters', () => {
    beforeAll(() => {
      fetchMock.mockGlobal();
    });

    afterAll(() => {
      fetchMock.unmockGlobal();
    });

    afterEach(() => {
      fetchMock.removeRoutes();
    });

    it('should prevent retry loops (Fetch)', async () => {
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
  });
});
