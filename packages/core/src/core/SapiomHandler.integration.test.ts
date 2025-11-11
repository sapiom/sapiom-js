/**
 * Integration tests for unified SapiomHandler
 * Tests combined authorization + payment flow
 */
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { createAxiosAdapter } from '../http/adapters/axios';
import { SapiomClient } from '../lib/SapiomClient';
import { TransactionAPI } from '../lib/TransactionAPI';
import { TransactionStatus } from '../types/transaction';
import { withSapiomHandling } from './SapiomHandler';

describe('Unified Sapiom Handler Integration Tests', () => {
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

  it('should handle authorization THEN payment in sequence', async () => {
    const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
    const mockAxios = new MockAdapter(axiosInstance);
    const adapter = createAxiosAdapter(axiosInstance);

    const callbacks = {
      onAuthorizationSuccess: jest.fn(),
      onPaymentSuccess: jest.fn(),
    };

    withSapiomHandling(adapter, {
      sapiomClient: mockSapiomClient,

      authorization: {
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/premium\//,
            serviceName: 'premium-api',
          },
        ],
        onAuthorizationSuccess: callbacks.onAuthorizationSuccess,
      },

      payment: {
        onPaymentSuccess: callbacks.onPaymentSuccess,
      },
    });

    // Step 1: First request with authorization
    mockAxios.onGet('/api/premium/paid-data').replyOnce(402, {
      x402Version: 1,
      accepts: [
        {
          scheme: 'exact',
          network: 'base',
          maxAmountRequired: '5000000',
          resourceName: 'https://api.example.com/api/premium/paid-data',
          payTo: '0x123',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        },
      ],
    });

    // Step 2: Retry with payment
    mockAxios.onGet('/api/premium/paid-data').reply((config) => {
      // Should have both headers
      const hasAuthHeader = config.headers?.['X-Sapiom-Transaction-Id'];
      const hasPaymentHeader = config.headers?.['X-PAYMENT'];

      if (hasAuthHeader && hasPaymentHeader) {
        return [200, { premium: 'data', paid: true }];
      }
      return [403, { error: 'Missing headers' }];
    });

    // Authorization transaction (no payment)
    const authTx = {
      id: 'tx_auth',
      status: TransactionStatus.AUTHORIZED,
      requiresPayment: false,
    } as any;

    // After reauthorization with payment
    const reauthorizedTx = {
      id: 'tx_auth', // Same ID!
      status: TransactionStatus.AUTHORIZED,
      requiresPayment: true,
      payment: {
        authorizationPayload: 'PAYMENT_PROOF',
      },
    } as any;

    // Create only called ONCE for authorization
    mockTransactionAPI.create.mockResolvedValueOnce(authTx);

    // Payment handler gets the existing auth transaction
    mockTransactionAPI.get.mockResolvedValueOnce(authTx);

    // Payment handler reauthorizes it with payment (returns immediately authorized)
    mockTransactionAPI.reauthorizeWithPayment.mockResolvedValueOnce(reauthorizedTx);

    // Any subsequent get() calls during polling return reauthorized tx
    mockTransactionAPI.get.mockResolvedValue(reauthorizedTx);

    const response = await axiosInstance.get('/api/premium/paid-data');

    // Should succeed with both authorization and payment
    expect(response.data).toEqual({ premium: 'data', paid: true });

    // Verify only ONE transaction was created (for authorization)
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(1);

    // Verify authorization handler was NOT called on retry (would call get() again)
    expect(mockTransactionAPI.get).toHaveBeenCalledTimes(1); // Only once, not twice

    // Verify it was reauthorized with payment (not created anew)
    expect(mockTransactionAPI.reauthorizeWithPayment).toHaveBeenCalledWith(
      'tx_auth',
      expect.objectContaining({
        protocol: 'x402',
        network: 'base',
      }),
    );

    // Verify onAuthorizationSuccess called only ONCE (not on retry)
    expect(callbacks.onAuthorizationSuccess).toHaveBeenCalledTimes(1);

    // Verify payment callback invoked
    expect(callbacks.onPaymentSuccess).toHaveBeenCalled();

    mockAxios.restore();
  });

  it('should work with only authorization (payment explicitly disabled)', async () => {
    const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
    const mockAxios = new MockAdapter(axiosInstance);
    const adapter = createAxiosAdapter(axiosInstance);

    withSapiomHandling(adapter, {
      sapiomClient: mockSapiomClient,

      authorization: {
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: 'admin-api',
          },
        ],
      },

      payment: {
        enabled: false, // Explicitly disable payment
      },
    });

    mockAxios.onGet('/api/admin/users').reply(200, { users: [] });

    mockTransactionAPI.create.mockResolvedValue({
      id: 'tx_auth_only',
      status: TransactionStatus.AUTHORIZED,
    } as any);

    const response = await axiosInstance.get('/api/admin/users');

    expect(response.data).toEqual({ users: [] });
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(1); // Only auth

    mockAxios.restore();
  });

  it('should handle payment with authorization disabled via __sapiom', async () => {
    const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
    const mockAxios = new MockAdapter(axiosInstance);
    const adapter = createAxiosAdapter(axiosInstance);

    withSapiomHandling(adapter, {
      sapiomClient: mockSapiomClient,
      // Both handlers attached, but we'll skip authorization via __sapiom
    });

    // First call: 402
    mockAxios.onGet('/premium').replyOnce(402, {
      requiresPayment: true,
      paymentData: {
        protocol: 'x402',
        network: 'base',
        token: 'USDC',
        scheme: 'exact',
        amount: '1000000',
        payTo: '0x456',
        payToType: 'address',
      },
    });

    // Second call: success
    mockAxios.onGet('/premium').reply(200, { data: 'premium' });

    mockTransactionAPI.create.mockResolvedValue({
      id: 'tx_payment_only',
      status: TransactionStatus.AUTHORIZED,
      requiresPayment: true,
      payment: {
        authorizationPayload: 'PROOF',
      },
    } as any);

    const response = await axiosInstance.get('/premium', {
      // @ts-ignore
      __sapiom: {
        skipAuthorization: true, // Skip auth, but handle payment
      },
    });

    expect(response.data).toEqual({ data: 'premium' });
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(1); // Only payment

    mockAxios.restore();
  });

  it('should handle authorization with __sapiom override and then payment', async () => {
    const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
    const mockAxios = new MockAdapter(axiosInstance);
    const adapter = createAxiosAdapter(axiosInstance);

    withSapiomHandling(adapter, {
      sapiomClient: mockSapiomClient,

      authorization: {
        // No patterns - would authorize all, but __sapiom can override
      },

      payment: {},
    });

    // First request: 402 payment required
    mockAxios.onPost('/custom/action').replyOnce(402, {
      requiresPayment: true,
      paymentData: {
        protocol: 'x402',
        network: 'base',
        token: 'USDC',
        scheme: 'exact',
        amount: '2000000',
        payTo: '0x789',
        payToType: 'address',
      },
    });

    // Second request (retry with payment): success
    mockAxios.onPost('/custom/action').reply(200, { success: true });

    // Authorization transaction (no payment yet)
    const authTx = {
      id: 'tx_custom_auth',
      status: TransactionStatus.AUTHORIZED,
      requiresPayment: false,
    } as any;

    // After reauthorization with payment
    const reauthorizedTx = {
      id: 'tx_custom_auth', // Same transaction ID!
      status: TransactionStatus.AUTHORIZED,
      requiresPayment: true,
      payment: {
        authorizationPayload: 'CUSTOM_PROOF',
      },
    } as any;

    // Authorization creates transaction
    mockTransactionAPI.create.mockResolvedValueOnce(authTx);

    // Payment handler gets existing transaction
    mockTransactionAPI.get.mockResolvedValueOnce(authTx);

    // Payment handler reauthorizes with payment
    mockTransactionAPI.reauthorizeWithPayment.mockResolvedValueOnce(reauthorizedTx);

    // Any subsequent get() calls return reauthorized transaction
    mockTransactionAPI.get.mockResolvedValue(reauthorizedTx);

    const response = await axiosInstance.post(
      '/custom/action',
      { data: 'test' },
      {
        // @ts-ignore
        __sapiom: {
          serviceName: 'custom-service',
          actionName: 'custom-action',
          resourceName: 'custom:resource',
        },
      },
    );

    expect(response.data).toEqual({ success: true });

    // Verify authorization transaction was created with custom metadata
    expect(mockTransactionAPI.create).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'custom-service',
        actionName: 'custom-action',
        resourceName: 'custom:resource',
      }),
    );

    // Verify payment handler detected existing transaction and reauthorized it
    expect(mockTransactionAPI.get).toHaveBeenCalledWith('tx_custom_auth');
    expect(mockTransactionAPI.reauthorizeWithPayment).toHaveBeenCalledWith(
      'tx_custom_auth',
      expect.objectContaining({
        protocol: 'x402',
        network: 'base',
      }),
    );

    mockAxios.restore();
  });

  it('should respect enabled: false for authorization', async () => {
    const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
    const mockAxios = new MockAdapter(axiosInstance);
    const adapter = createAxiosAdapter(axiosInstance);

    withSapiomHandling(adapter, {
      sapiomClient: mockSapiomClient,

      authorization: {
        enabled: false, // Explicitly disable
      },

      payment: {
        enabled: false, // Also disable payment for this test
      },
    });

    mockAxios.onGet('/any/endpoint').reply(200, { data: 'public' });

    const response = await axiosInstance.get('/any/endpoint');

    expect(response.data).toEqual({ data: 'public' });

    // Neither handler should be invoked
    expect(mockTransactionAPI.create).not.toHaveBeenCalled();
    expect(mockTransactionAPI.get).not.toHaveBeenCalled();

    mockAxios.restore();
  });
});
