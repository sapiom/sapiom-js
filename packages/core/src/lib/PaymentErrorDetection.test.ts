import fetchMock from '@fetch-mock/jest';
import axios, { AxiosError, AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import nock from 'nock';

import { FetchAdapter } from '../http/adapters/fetch';
import { NodeHttpAdapter } from '../http/adapters/node-http';
import { HttpError } from '../http/types';
import { PaymentData } from '../types/transaction';
import {
  ErrorDetectorAdapter,
  ExtractedPaymentInfo,
  PaymentRequiredError,
  X402PaymentResponse,
  convertX402ToPaymentData,
  extractPaymentData,
  extractResourceFromError,
  extractTransactionId,
  isAxios402Error,
  isHttp402Error,
  isPaymentRequiredError,
  registerErrorDetector,
  wrapWith402Detection,
} from './PaymentErrorDetection';

describe('PaymentErrorDetection', () => {
  describe('PaymentRequiredError', () => {
    it('should create error with all properties', () => {
      const paymentData: PaymentData = {
        protocol: 'x402',
        network: 'base-sepolia',
        token: 'USDC',
        scheme: 'exact',
        amount: '1000000',
        payTo: '0x1234567890123456789012345678901234567890',
        payToType: 'address',
      };

      const error = new PaymentRequiredError(
        'Payment required',
        paymentData,
        'https://api.example.com/premium',
        'tx_123',
      );

      expect(error.name).toBe('PaymentRequiredError');
      expect(error.message).toBe('Payment required');
      expect(error.statusCode).toBe(402);
      expect(error.paymentData).toEqual(paymentData);
      expect(error.resource).toBe('https://api.example.com/premium');
      expect(error.transactionId).toBe('tx_123');
    });

    it('should maintain stack trace', () => {
      const error = new PaymentRequiredError('Payment required', {} as PaymentData, 'test');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('PaymentRequiredError');
    });
  });

  describe('isPaymentRequiredError', () => {
    it('should detect PaymentRequiredError instances', () => {
      const error = new PaymentRequiredError('test', {} as PaymentData, 'resource');
      expect(isPaymentRequiredError(error)).toBe(true);
    });

    it('should detect Axios 402 errors', () => {
      const error = new AxiosError(
        'Payment Required',
        '402',
        undefined,
        {},
        {
          status: 402,
          statusText: 'Payment Required',
          data: {},
          headers: {},
          config: {} as any,
        },
      );

      expect(isPaymentRequiredError(error)).toBe(true);
    });

    it('should detect HttpError 402 errors', () => {
      const error: HttpError = {
        message: 'Payment Required',
        status: 402,
        data: {},
      };

      expect(isPaymentRequiredError(error)).toBe(true);
    });

    it('should detect errors with "payment required" message', () => {
      const error = new Error('Payment required for this resource');
      expect(isPaymentRequiredError(error)).toBe(true);
    });

    it('should detect errors with 402 in message', () => {
      const error = new Error('HTTP 402 error occurred');
      expect(isPaymentRequiredError(error)).toBe(true);
    });

    it('should return false for non-payment errors', () => {
      expect(isPaymentRequiredError(new Error('Not found'))).toBe(false);
      expect(isPaymentRequiredError(null)).toBe(false);
      expect(isPaymentRequiredError(undefined)).toBe(false);
      expect(isPaymentRequiredError({ status: 404 })).toBe(false);
    });
  });

  describe('isAxios402Error', () => {
    it('should detect Axios 402 errors', () => {
      const error = new AxiosError(
        'Payment Required',
        '402',
        undefined,
        {},
        {
          status: 402,
          statusText: 'Payment Required',
          data: {},
          headers: {},
          config: {} as any,
        },
      );

      expect(isAxios402Error(error)).toBe(true);
    });

    it('should return false for non-402 Axios errors', () => {
      const error = new AxiosError(
        'Not Found',
        '404',
        undefined,
        {},
        {
          status: 404,
          statusText: 'Not Found',
          data: {},
          headers: {},
          config: {} as any,
        },
      );

      expect(isAxios402Error(error)).toBe(false);
    });

    it('should return false for non-Axios errors', () => {
      expect(isAxios402Error(new Error('test'))).toBe(false);
      expect(isAxios402Error({ status: 402 })).toBe(false);
    });
  });

  describe('isHttp402Error', () => {
    it('should detect HttpError 402 errors', () => {
      const error: HttpError = {
        message: 'Payment Required',
        status: 402,
      };

      expect(isHttp402Error(error)).toBe(true);
    });

    it('should return false for non-402 HttpErrors', () => {
      const error: HttpError = {
        message: 'Not Found',
        status: 404,
      };

      expect(isHttp402Error(error)).toBe(false);
    });

    it('should return false for non-HttpError objects', () => {
      expect(isHttp402Error(new Error('test'))).toBe(false);
      expect(isHttp402Error(null)).toBe(false);
    });
  });

  describe('extractPaymentData', () => {
    it('should extract from PaymentRequiredError', () => {
      const paymentData: PaymentData = {
        protocol: 'x402',
        network: 'base',
        token: 'USDC',
        scheme: 'exact',
        amount: '5000000',
        payTo: '0xabc',
        payToType: 'address',
      };

      const error = new PaymentRequiredError('test', paymentData, 'resource');
      const extracted = extractPaymentData(error);

      expect(extracted).toEqual(paymentData);
    });

    it('should extract from x402 format in AxiosError', () => {
      const x402Data: X402PaymentResponse = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '1000000',
            resource: 'https://api.example.com/data',
            payTo: '0x1234567890123456789012345678901234567890',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
        ],
      };

      const error = new AxiosError(
        'Payment Required',
        '402',
        { url: 'https://api.example.com/data' } as any,
        {},
        {
          status: 402,
          statusText: 'Payment Required',
          data: x402Data,
          headers: {},
          config: {} as any,
        },
      );

      const paymentData = extractPaymentData(error);

      expect(paymentData.protocol).toBe('x402');
      expect(paymentData.network).toBe('base-sepolia');
      expect(paymentData.token).toBe('USDC');
      expect(paymentData.amount).toBe('1000000');
      expect(paymentData.payTo).toBe('0x1234567890123456789012345678901234567890');
      expect(paymentData.protocolMetadata?.x402Version).toBe(1);
    });

    it('should extract from Sapiom format in HttpError', () => {
      const paymentData: PaymentData = {
        protocol: 'x402',
        network: 'base',
        token: 'USDC',
        scheme: 'exact',
        amount: '5000000',
        payTo: '0xabc',
        payToType: 'address',
      };

      const error: HttpError = {
        message: 'Payment Required',
        status: 402,
        data: {
          requiresPayment: true,
          paymentData,
        },
      };

      const extracted = extractPaymentData(error);
      expect(extracted).toEqual(paymentData);
    });

    it('should throw if cannot extract payment data', () => {
      const error = new Error('Generic error');
      expect(() => extractPaymentData(error)).toThrow('Unable to extract payment data');
    });
  });

  describe('extractResourceFromError', () => {
    it('should extract from PaymentRequiredError', () => {
      const error = new PaymentRequiredError('test', {} as PaymentData, 'https://api.example.com/resource');

      expect(extractResourceFromError(error)).toBe('https://api.example.com/resource');
    });

    it('should extract from x402 response', () => {
      const x402Data: X402PaymentResponse = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base',
            maxAmountRequired: '1000000',
            resource: 'https://api.example.com/premium',
            payTo: '0x123',
            asset: '0xUSDC',
          },
        ],
      };

      const error = new AxiosError(
        'Payment Required',
        '402',
        { url: 'https://api.example.com/fallback' } as any,
        {},
        {
          status: 402,
          statusText: 'Payment Required',
          data: x402Data,
          headers: {},
          config: {} as any,
        },
      );

      expect(extractResourceFromError(error)).toBe('https://api.example.com/premium');
    });

    it('should fallback to request URL for AxiosError', () => {
      const error = new AxiosError(
        'Payment Required',
        '402',
        { url: 'https://api.example.com/fallback' } as any,
        {},
        {
          status: 402,
          statusText: 'Payment Required',
          data: {},
          headers: {},
          config: {} as any,
        },
      );

      expect(extractResourceFromError(error)).toBe('https://api.example.com/fallback');
    });

    it('should throw for non-payment errors', () => {
      expect(() => extractResourceFromError(new Error('test'))).toThrow('Unable to extract payment data');
    });
  });

  describe('extractTransactionId', () => {
    it('should extract from PaymentRequiredError', () => {
      const error = new PaymentRequiredError('test', {} as PaymentData, 'resource', 'tx_abc123');

      expect(extractTransactionId(error)).toBe('tx_abc123');
    });

    it('should extract from Sapiom response in AxiosError', () => {
      const error = new AxiosError(
        'Payment Required',
        '402',
        undefined,
        {},
        {
          status: 402,
          statusText: 'Payment Required',
          data: {
            requiresPayment: true,
            transactionId: 'tx_xyz789',
            paymentData: {} as PaymentData,
          },
          headers: {},
          config: {} as any,
        },
      );

      expect(extractTransactionId(error)).toBe('tx_xyz789');
    });

    it('should extract from header in HttpError', () => {
      const error: HttpError = {
        message: 'Payment Required',
        status: 402,
        headers: {
          'x-sapiom-transaction-id': 'tx_header123',
        },
        data: {},
      };

      expect(extractTransactionId(error)).toBe('tx_header123');
    });

    it('should return undefined if no transaction ID found', () => {
      const error: HttpError = {
        message: 'Payment Required',
        status: 402,
        data: {},
      };

      expect(extractTransactionId(error)).toBeUndefined();
    });
  });

  describe('convertX402ToPaymentData', () => {
    it('should convert x402 response to PaymentData', () => {
      const x402Response: X402PaymentResponse = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '1000000',
            resource: 'https://api.example.com/data',
            description: 'Premium data access',
            mimeType: 'application/json',
            payTo: '0x1234567890123456789012345678901234567890',
            maxTimeoutSeconds: 300,
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
        ],
      };

      const paymentData = convertX402ToPaymentData(x402Response, 'https://api.example.com/data');

      expect(paymentData.protocol).toBe('x402');
      expect(paymentData.network).toBe('base-sepolia');
      expect(paymentData.token).toBe('USDC');
      expect(paymentData.scheme).toBe('exact');
      expect(paymentData.amount).toBe('1000000');
      expect(paymentData.payTo).toBe('0x1234567890123456789012345678901234567890');
      expect(paymentData.payToType).toBe('address');
      expect(paymentData.protocolMetadata?.x402Version).toBe(1);
      expect(paymentData.protocolMetadata?.resource).toBe('https://api.example.com/data');
      expect(paymentData.protocolMetadata?.originalRequirement).toEqual(x402Response.accepts[0]);
    });

    it('should extract token symbol from known addresses', () => {
      const x402Response: X402PaymentResponse = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base',
            maxAmountRequired: '1000000',
            resource: 'https://api.example.com/data',
            payTo: '0x123',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
          },
        ],
      };

      const paymentData = convertX402ToPaymentData(x402Response, '');

      expect(paymentData.token).toBe('USDC');
      expect(paymentData.network).toBe('base');
    });

    it('should default to USDC for unknown token addresses', () => {
      const x402Response: X402PaymentResponse = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'unknown-network',
            maxAmountRequired: '1000000',
            resource: 'https://api.example.com/data',
            payTo: '0x123',
            asset: '0xUnknownToken',
          },
        ],
      };

      const paymentData = convertX402ToPaymentData(x402Response, '');

      expect(paymentData.token).toBe('USDC');
    });

    it('should throw if no payment requirements', () => {
      const x402Response: X402PaymentResponse = {
        x402Version: 1,
        accepts: [],
      };

      expect(() => convertX402ToPaymentData(x402Response, '')).toThrow('No payment requirements in x402 response');
    });
  });

  describe('wrapWith402Detection', () => {
    it('should convert 402 errors to PaymentRequiredError', async () => {
      const fn = async () => {
        throw new AxiosError(
          'Payment Required',
          '402',
          { url: 'https://api.example.com' } as any,
          {},
          {
            status: 402,
            statusText: 'Payment Required',
            data: {
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
            headers: {},
            config: {} as any,
          },
        );
      };

      const wrapped = wrapWith402Detection(fn);

      await expect(wrapped()).rejects.toThrow(PaymentRequiredError);
      await expect(wrapped()).rejects.toMatchObject({
        statusCode: 402,
        resource: 'https://api.example.com',
      });
    });

    it('should pass through non-402 errors', async () => {
      const fn = async () => {
        throw new Error('Not a payment error');
      };

      const wrapped = wrapWith402Detection(fn);

      await expect(wrapped()).rejects.toThrow('Not a payment error');
      await expect(wrapped()).rejects.not.toThrow(PaymentRequiredError);
    });

    it('should pass through PaymentRequiredError as-is', async () => {
      const originalError = new PaymentRequiredError('test', {} as PaymentData, 'resource');
      const fn = async () => {
        throw originalError;
      };

      const wrapped = wrapWith402Detection(fn);

      await expect(wrapped()).rejects.toBe(originalError);
    });
  });

  describe('registerErrorDetector', () => {
    it('should allow registering custom error detector', () => {
      // Create a custom error type
      class CustomHTTPError extends Error {
        constructor(
          public statusCode: number,
          public responseBody: any,
          public requestUrl: string,
        ) {
          super(`HTTP ${statusCode}`);
          this.name = 'CustomHTTPError';
        }
      }

      // Create custom detector
      class CustomErrorDetector implements ErrorDetectorAdapter {
        canHandle(error: unknown): boolean {
          return error instanceof CustomHTTPError;
        }

        is402Error(error: unknown): boolean {
          if (!this.canHandle(error)) return false;
          return (error as CustomHTTPError).statusCode === 402;
        }

        extractPaymentInfo(error: unknown): ExtractedPaymentInfo {
          const customError = error as CustomHTTPError;
          return {
            paymentData: {
              protocol: 'x402',
              network: 'base',
              token: 'USDC',
              scheme: 'exact',
              amount: customError.responseBody.amount || '1000000',
              payTo: customError.responseBody.payTo || '0x123',
              payToType: 'address',
            },
            resource: customError.requestUrl,
            transactionId: customError.responseBody.transactionId,
          };
        }
      }

      // Register the detector
      registerErrorDetector(new CustomErrorDetector());

      // Test with custom error
      const customError = new CustomHTTPError(
        402,
        { amount: '5000000', payTo: '0xabc', transactionId: 'tx_custom' },
        'https://custom-api.com/endpoint',
      );

      expect(isPaymentRequiredError(customError)).toBe(true);

      const paymentData = extractPaymentData(customError);
      expect(paymentData.amount).toBe('5000000');

      const resource = extractResourceFromError(customError);
      expect(resource).toBe('https://custom-api.com/endpoint');

      const txId = extractTransactionId(customError);
      expect(txId).toBe('tx_custom');
    });
  });

  describe('real HTTP library integration', () => {
    it('should detect and extract from real Axios 402 response', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
      const mockAxios = new MockAdapter(axiosInstance);

      const x402PaymentData: X402PaymentResponse = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '15000000', // $15 USDC
            resource: 'https://api.example.com/premium-data',
            description: 'Access to premium financial data',
            mimeType: 'application/json',
            payTo: '0x9876543210fedcba9876543210fedcba98765432',
            maxTimeoutSeconds: 300,
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
        ],
      };

      mockAxios.onGet('/premium-data').reply(402, x402PaymentData, {
        'x-payment-required': 'true',
      });

      let caughtError: unknown;

      try {
        await axiosInstance.get('/premium-data');
      } catch (error) {
        caughtError = error;
      }

      // Verify error was caught
      expect(caughtError).toBeDefined();

      // Test detection functions on real Axios error
      expect(isPaymentRequiredError(caughtError)).toBe(true);
      expect(isAxios402Error(caughtError)).toBe(true);

      // Test extraction functions
      const paymentData = extractPaymentData(caughtError);
      expect(paymentData.protocol).toBe('x402');
      expect(paymentData.network).toBe('base-sepolia');
      expect(paymentData.token).toBe('USDC');
      expect(paymentData.amount).toBe('15000000');
      expect(paymentData.payTo).toBe('0x9876543210fedcba9876543210fedcba98765432');
      expect(paymentData.protocolMetadata?.description).toBe('Access to premium financial data');

      const resource = extractResourceFromError(caughtError);
      expect(resource).toBe('https://api.example.com/premium-data');

      const transactionId = extractTransactionId(caughtError);
      expect(transactionId).toBeUndefined(); // No pre-existing transaction

      mockAxios.restore();
    });

    it('should detect and extract from real Axios 402 with Sapiom format', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
      const mockAxios = new MockAdapter(axiosInstance);

      const sapiomPaymentData = {
        requiresPayment: true,
        transactionId: 'tx_existing_abc123',
        paymentData: {
          protocol: 'x402',
          network: 'base',
          token: 'USDC',
          scheme: 'exact',
          amount: '5000000', // $5 USDC
          payTo: '0xdef456',
          payToType: 'address',
          protocolMetadata: {
            x402Version: 1,
            resource: 'https://api.example.com/api/v1/query',
          },
        },
        message: 'Payment required for premium query',
      };

      mockAxios.onPost('/api/v1/query').reply(402, sapiomPaymentData, {
        'x-sapiom-transaction-id': 'tx_existing_abc123',
      });

      let caughtError: unknown;

      try {
        await axiosInstance.post('/api/v1/query', { query: 'test' });
      } catch (error) {
        caughtError = error;
      }

      // Verify error detection
      expect(isPaymentRequiredError(caughtError)).toBe(true);
      expect(isAxios402Error(caughtError)).toBe(true);

      // Test extraction
      const paymentData = extractPaymentData(caughtError);
      expect(paymentData.amount).toBe('5000000');
      expect(paymentData.network).toBe('base');

      const resource = extractResourceFromError(caughtError);
      expect(resource).toBe('/api/v1/query');

      const transactionId = extractTransactionId(caughtError);
      expect(transactionId).toBe('tx_existing_abc123');

      mockAxios.restore();
    });

    it('should detect and extract from real Node.js HTTP 402 response', async () => {
      const adapter = new NodeHttpAdapter();
      const baseURL = 'https://api.example.com';

      const x402PaymentData: X402PaymentResponse = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base',
            maxAmountRequired: '25000000', // $25 USDC
            resource: 'https://api.example.com/enterprise/data',
            description: 'Enterprise-tier data access',
            mimeType: 'application/json',
            payTo: '0xfedcba9876543210fedcba9876543210fedcba98',
            maxTimeoutSeconds: 600,
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
          },
        ],
      };

      nock(baseURL).get('/enterprise/data').reply(402, x402PaymentData, {
        'x-payment-required': 'true',
        'content-type': 'application/json',
      });

      let caughtError: unknown;

      try {
        await adapter.request({
          method: 'GET',
          url: `${baseURL}/enterprise/data`,
          headers: {},
        });
      } catch (error) {
        caughtError = error;
      }

      // Verify error was caught
      expect(caughtError).toBeDefined();

      // Test detection functions on real Node HTTP error
      expect(isPaymentRequiredError(caughtError)).toBe(true);
      expect(isHttp402Error(caughtError)).toBe(true);

      // Test extraction functions
      const paymentData = extractPaymentData(caughtError);
      expect(paymentData.protocol).toBe('x402');
      expect(paymentData.network).toBe('base');
      expect(paymentData.token).toBe('USDC');
      expect(paymentData.amount).toBe('25000000');
      expect(paymentData.payTo).toBe('0xfedcba9876543210fedcba9876543210fedcba98');
      expect(paymentData.protocolMetadata?.description).toBe('Enterprise-tier data access');

      const resource = extractResourceFromError(caughtError);
      expect(resource).toBe('https://api.example.com/enterprise/data');

      const transactionId = extractTransactionId(caughtError);
      expect(transactionId).toBeUndefined();

      nock.cleanAll();
    });

    it('should detect and extract from real Node.js HTTP 402 with Sapiom format', async () => {
      const adapter = new NodeHttpAdapter();
      const baseURL = 'https://api.sapiom.com';

      const sapiomPaymentData = {
        requiresPayment: true,
        transactionId: 'tx_node_http_123',
        paymentData: {
          protocol: 'x402',
          network: 'base-sepolia',
          token: 'USDC',
          scheme: 'exact',
          amount: '8000000', // $8 USDC
          payTo: '0x789abc',
          payToType: 'address',
          protocolMetadata: {
            x402Version: 1,
            resource: 'https://api.sapiom.com/v1/analytics',
            description: 'Analytics API access',
          },
        },
        message: 'Payment required for analytics access',
      };

      nock(baseURL).post('/v1/analytics').reply(402, sapiomPaymentData, {
        'x-sapiom-transaction-id': 'tx_node_http_123',
        'content-type': 'application/json',
      });

      let caughtError: unknown;

      try {
        await adapter.request({
          method: 'POST',
          url: `${baseURL}/v1/analytics`,
          headers: { 'Content-Type': 'application/json' },
          body: { metric: 'revenue' },
        });
      } catch (error) {
        caughtError = error;
      }

      // Verify error detection
      expect(isPaymentRequiredError(caughtError)).toBe(true);
      expect(isHttp402Error(caughtError)).toBe(true);

      // Test extraction
      const paymentData = extractPaymentData(caughtError);
      expect(paymentData.amount).toBe('8000000');
      expect(paymentData.network).toBe('base-sepolia');
      expect(paymentData.protocolMetadata?.description).toBe('Analytics API access');

      const resource = extractResourceFromError(caughtError);
      expect(resource).toBe('https://api.sapiom.com/v1/analytics');

      const transactionId = extractTransactionId(caughtError);
      expect(transactionId).toBe('tx_node_http_123');

      nock.cleanAll();
    });

    it('should detect and extract from real Fetch 402 response', async () => {
      fetchMock.mockGlobal();

      const adapter = new FetchAdapter('https://api.example.com');
      const x402PaymentData: X402PaymentResponse = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '12000000', // $12 USDC
            resource: 'https://api.example.com/streaming/data',
            description: 'Real-time streaming data',
            mimeType: 'application/json',
            payTo: '0xaabbccddee1122334455667788990011223344ff',
            maxTimeoutSeconds: 180,
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
        ],
      };

      fetchMock.route('https://api.example.com/streaming/data', {
        status: 402,
        body: x402PaymentData,
        headers: {
          'x-payment-required': 'true',
          'content-type': 'application/json',
        },
      });

      let caughtError: unknown;

      try {
        await adapter.request({
          method: 'GET',
          url: '/streaming/data',
          headers: {},
        });
      } catch (error) {
        caughtError = error;
      }

      // Verify error was caught
      expect(caughtError).toBeDefined();

      // Test detection functions on real Fetch error
      expect(isPaymentRequiredError(caughtError)).toBe(true);
      expect(isHttp402Error(caughtError)).toBe(true);

      // Test extraction functions
      const paymentData = extractPaymentData(caughtError);
      expect(paymentData.protocol).toBe('x402');
      expect(paymentData.network).toBe('base-sepolia');
      expect(paymentData.token).toBe('USDC');
      expect(paymentData.amount).toBe('12000000');
      expect(paymentData.payTo).toBe('0xaabbccddee1122334455667788990011223344ff');
      expect(paymentData.protocolMetadata?.description).toBe('Real-time streaming data');

      const resource = extractResourceFromError(caughtError);
      expect(resource).toBe('https://api.example.com/streaming/data');

      const transactionId = extractTransactionId(caughtError);
      expect(transactionId).toBeUndefined();

      fetchMock.removeRoutes();
      fetchMock.unmockGlobal();
    });

    it('should detect and extract from real Fetch 402 with Sapiom format', async () => {
      fetchMock.mockGlobal();

      const adapter = new FetchAdapter('https://api.sapiom.com');
      const sapiomPaymentData = {
        requiresPayment: true,
        transactionId: 'tx_fetch_456',
        paymentData: {
          protocol: 'x402',
          network: 'base',
          token: 'USDC',
          scheme: 'exact',
          amount: '3500000', // $3.50 USDC
          payTo: '0x112233',
          payToType: 'address',
          protocolMetadata: {
            x402Version: 1,
            resource: 'https://api.sapiom.com/v2/reports',
            description: 'Generate custom report',
          },
        },
        message: 'Payment required for report generation',
      };

      fetchMock.route('https://api.sapiom.com/v2/reports', {
        status: 402,
        body: sapiomPaymentData,
        headers: {
          'x-sapiom-transaction-id': 'tx_fetch_456',
          'content-type': 'application/json',
        },
      });

      let caughtError: unknown;

      try {
        await adapter.request({
          method: 'GET',
          url: '/v2/reports',
          headers: {},
        });
      } catch (error) {
        caughtError = error;
      }

      // Verify error detection
      expect(isPaymentRequiredError(caughtError)).toBe(true);
      expect(isHttp402Error(caughtError)).toBe(true);

      // Test extraction
      const paymentData = extractPaymentData(caughtError);
      expect(paymentData.amount).toBe('3500000');
      expect(paymentData.network).toBe('base');
      expect(paymentData.protocolMetadata?.description).toBe('Generate custom report');

      const resource = extractResourceFromError(caughtError);
      expect(resource).toBe('/v2/reports');

      const transactionId = extractTransactionId(caughtError);
      expect(transactionId).toBe('tx_fetch_456');

      fetchMock.removeRoutes();
      fetchMock.unmockGlobal();
    });

    describe('negative cases - non-payment errors and successes', () => {
      it('should return false for Axios 200 success response', async () => {
        const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
        const mockAxios = new MockAdapter(axiosInstance);

        mockAxios.onGet('/data').reply(200, { success: true });

        const response = await axiosInstance.get('/data');

        // Success responses should not be payment errors
        expect(isPaymentRequiredError(response)).toBe(false);
        expect(isAxios402Error(response)).toBe(false);

        mockAxios.restore();
      });

      it('should return false for Axios 404 error', async () => {
        const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
        const mockAxios = new MockAdapter(axiosInstance);

        mockAxios.onGet('/notfound').reply(404, { error: 'Not found' });

        let caughtError: unknown;

        try {
          await axiosInstance.get('/notfound');
        } catch (error) {
          caughtError = error;
        }

        // 404 errors should not be payment errors
        expect(isPaymentRequiredError(caughtError)).toBe(false);
        expect(isAxios402Error(caughtError)).toBe(false);

        mockAxios.restore();
      });

      it('should return false for Axios 500 error', async () => {
        const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
        const mockAxios = new MockAdapter(axiosInstance);

        mockAxios.onPost('/submit').reply(500, { error: 'Internal server error' });

        let caughtError: unknown;

        try {
          await axiosInstance.post('/submit', { data: 'test' });
        } catch (error) {
          caughtError = error;
        }

        // 500 errors should not be payment errors
        expect(isPaymentRequiredError(caughtError)).toBe(false);
        expect(isAxios402Error(caughtError)).toBe(false);

        mockAxios.restore();
      });

      it('should return false for Node.js HTTP 200 success response', async () => {
        const adapter = new NodeHttpAdapter();
        const baseURL = 'https://api.example.com';

        nock(baseURL).get('/data').reply(200, { success: true });

        const response = await adapter.request({
          method: 'GET',
          url: `${baseURL}/data`,
          headers: {},
        });

        // Success responses should not be payment errors
        expect(isPaymentRequiredError(response)).toBe(false);
        expect(isHttp402Error(response)).toBe(false);

        nock.cleanAll();
      });

      it('should return false for Node.js HTTP 404 error', async () => {
        const adapter = new NodeHttpAdapter();
        const baseURL = 'https://api.example.com';

        nock(baseURL).get('/notfound').reply(404, { error: 'Not found' });

        let caughtError: unknown;

        try {
          await adapter.request({
            method: 'GET',
            url: `${baseURL}/notfound`,
            headers: {},
          });
        } catch (error) {
          caughtError = error;
        }

        // 404 errors should not be payment errors
        expect(isPaymentRequiredError(caughtError)).toBe(false);
        expect(isHttp402Error(caughtError)).toBe(false);

        nock.cleanAll();
      });

      it('should return false for Node.js HTTP 500 error', async () => {
        const adapter = new NodeHttpAdapter();
        const baseURL = 'https://api.example.com';

        nock(baseURL).post('/submit').reply(500, { error: 'Internal server error' });

        let caughtError: unknown;

        try {
          await adapter.request({
            method: 'POST',
            url: `${baseURL}/submit`,
            headers: { 'Content-Type': 'application/json' },
            body: { data: 'test' },
          });
        } catch (error) {
          caughtError = error;
        }

        // 500 errors should not be payment errors
        expect(isPaymentRequiredError(caughtError)).toBe(false);
        expect(isHttp402Error(caughtError)).toBe(false);

        nock.cleanAll();
      });

      it('should return false for Fetch 200 success response', async () => {
        fetchMock.mockGlobal();

        const adapter = new FetchAdapter('https://api.example.com');

        fetchMock.route('https://api.example.com/data', {
          status: 200,
          body: { success: true },
        });

        const response = await adapter.request({
          method: 'GET',
          url: '/data',
          headers: {},
        });

        // Success responses should not be payment errors
        expect(isPaymentRequiredError(response)).toBe(false);
        expect(isHttp402Error(response)).toBe(false);

        fetchMock.removeRoutes();
        fetchMock.unmockGlobal();
      });

      it('should return false for Fetch 404 error', async () => {
        fetchMock.mockGlobal();

        const adapter = new FetchAdapter('https://api.example.com');

        fetchMock.route('https://api.example.com/notfound', {
          status: 404,
          body: { error: 'Not found' },
        });

        let caughtError: unknown;

        try {
          await adapter.request({
            method: 'GET',
            url: '/notfound',
            headers: {},
          });
        } catch (error) {
          caughtError = error;
        }

        // 404 errors should not be payment errors
        expect(isPaymentRequiredError(caughtError)).toBe(false);
        expect(isHttp402Error(caughtError)).toBe(false);

        fetchMock.removeRoutes();
        fetchMock.unmockGlobal();
      });

      it('should return false for Fetch 500 error', async () => {
        fetchMock.mockGlobal();

        const adapter = new FetchAdapter('https://api.example.com');

        fetchMock.route('https://api.example.com/submit', {
          status: 500,
          body: { error: 'Internal server error' },
        });

        let caughtError: unknown;

        try {
          await adapter.request({
            method: 'POST',
            url: '/submit',
            headers: { 'Content-Type': 'application/json' },
            body: { data: 'test' },
          });
        } catch (error) {
          caughtError = error;
        }

        // 500 errors should not be payment errors
        expect(isPaymentRequiredError(caughtError)).toBe(false);
        expect(isHttp402Error(caughtError)).toBe(false);

        fetchMock.removeRoutes();
        fetchMock.unmockGlobal();
      });

      it('should return false for Axios network errors', async () => {
        const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
        const mockAxios = new MockAdapter(axiosInstance);

        mockAxios.onGet('/timeout').networkError();

        let caughtError: unknown;

        try {
          await axiosInstance.get('/timeout');
        } catch (error) {
          caughtError = error;
        }

        // Network errors should not be payment errors
        expect(isPaymentRequiredError(caughtError)).toBe(false);
        expect(isAxios402Error(caughtError)).toBe(false);

        mockAxios.restore();
      });

      it('should return false for Node.js HTTP network errors', async () => {
        const adapter = new NodeHttpAdapter();

        nock('https://api.example.com').get('/timeout').replyWithError('Network timeout');

        let caughtError: unknown;

        try {
          await adapter.request({
            method: 'GET',
            url: 'https://api.example.com/timeout',
            headers: {},
          });
        } catch (error) {
          caughtError = error;
        }

        // Network errors should not be payment errors
        expect(isPaymentRequiredError(caughtError)).toBe(false);
        expect(isHttp402Error(caughtError)).toBe(false);

        nock.cleanAll();
      });

      it('should return false for Fetch network errors', async () => {
        fetchMock.mockGlobal();

        const adapter = new FetchAdapter('https://api.example.com');

        fetchMock.route('https://api.example.com/timeout', {
          throws: new Error('Network timeout'),
        });

        let caughtError: unknown;

        try {
          await adapter.request({
            method: 'GET',
            url: '/timeout',
            headers: {},
          });
        } catch (error) {
          caughtError = error;
        }

        // Network errors should not be payment errors
        expect(isPaymentRequiredError(caughtError)).toBe(false);
        expect(isHttp402Error(caughtError)).toBe(false);

        fetchMock.removeRoutes();
        fetchMock.unmockGlobal();
      });
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete x402 workflow', () => {
      // Simulate 402 response from external API
      const x402Response: X402PaymentResponse = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '10500000',
            resource: 'https://premium-api.com/financial-data',
            description: 'Real-time stock data',
            mimeType: 'application/json',
            payTo: '0x9876543210fedcba9876543210fedcba98765432',
            maxTimeoutSeconds: 600,
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
        ],
      };

      const error = new AxiosError(
        'Payment Required',
        '402',
        { url: 'https://premium-api.com/financial-data' } as any,
        {},
        {
          status: 402,
          statusText: 'Payment Required',
          data: x402Response,
          headers: {
            'x-payment-required': 'true',
          },
          config: {} as any,
        },
      );

      // Verify all detection functions work
      expect(isPaymentRequiredError(error)).toBe(true);
      expect(isAxios402Error(error)).toBe(true);

      const paymentData = extractPaymentData(error);
      expect(paymentData.amount).toBe('10500000');
      expect(paymentData.token).toBe('USDC');

      const resource = extractResourceFromError(error);
      expect(resource).toBe('https://premium-api.com/financial-data');

      const transactionId = extractTransactionId(error);
      expect(transactionId).toBeUndefined();
    });

    it('should handle Sapiom format with existing transaction', () => {
      const error: HttpError = {
        message: 'Payment Required',
        status: 402,
        data: {
          requiresPayment: true,
          transactionId: 'tx_existing123',
          paymentData: {
            protocol: 'x402',
            network: 'base',
            token: 'USDC',
            scheme: 'exact',
            amount: '2000000',
            payTo: '0xdef',
            payToType: 'address',
            protocolMetadata: {
              x402Version: 1,
              resource: 'https://api.sapiom.com/service',
            },
          },
        },
        request: {
          method: 'POST',
          url: 'https://api.sapiom.com/service',
          headers: {},
        },
      };

      expect(isPaymentRequiredError(error)).toBe(true);
      expect(isHttp402Error(error)).toBe(true);

      const paymentData = extractPaymentData(error);
      expect(paymentData.amount).toBe('2000000');

      const resource = extractResourceFromError(error);
      expect(resource).toBe('https://api.sapiom.com/service');

      const transactionId = extractTransactionId(error);
      expect(transactionId).toBe('tx_existing123');
    });
  });
});
