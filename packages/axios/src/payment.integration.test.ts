/**
 * Integration tests for PaymentHandler with Axios adapter
 * Tests the complete 402 payment flow
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { createAxiosAdapter } from './adapter';
import { SapiomClient, TransactionAPI, TransactionStatus, withPaymentHandling } from '@sapiom/core';

describe('Axios Payment Integration', () => {
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
      addFacts: jest.fn(),
    } as any;

    mockSapiomClient = {
      transactions: mockTransactionAPI,
    } as any;
  });

  it('should handle 402 error and retry with payment', async () => {
    const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
    const mockAxios = new MockAdapter(axiosInstance);
    const adapter = createAxiosAdapter(axiosInstance);

    withPaymentHandling(adapter, {
      sapiomClient: mockSapiomClient,
    });

    let requestCount = 0;
    mockAxios.onPost('/premium').reply((config) => {
      requestCount++;
      if (requestCount === 1) {
        return [402, {
          requiresPayment: true,
          transactionId: 'tx-payment',
          paymentData: {
            protocol: 'x402',
            network: 'base-sepolia',
            token: 'USDC',
            amount: '1000000',
            payTo: '0x123',
            payToType: 'address',
            scheme: 'exact',
          },
        }];
      }
      return [200, { success: true }];
    });

    mockTransactionAPI.create.mockResolvedValue({
      id: 'tx-payment',
      status: TransactionStatus.AUTHORIZED,
      requiresPayment: true,
      payment: {
        authorizationPayload: 'PAYMENT_PROOF',
      },
    } as any);

    const response = await axiosInstance.post('/premium', { data: 'test' });

    expect(response.data).toEqual({ success: true });
    expect(requestCount).toBe(2);

    mockAxios.restore();
  });
});
