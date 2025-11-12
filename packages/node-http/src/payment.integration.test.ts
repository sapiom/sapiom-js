/**
 * Integration tests for PaymentHandler with Node HTTP adapter
 * Tests the complete payment flow with Node HTTP client
 */
import nock from 'nock';

import { createNodeHttpAdapter } from './adapter';
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

  describe('Trace and Agent Support', () => {
    afterEach(() => {
      nock.cleanAll();
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
