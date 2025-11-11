import axios, { AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { HttpRequest } from '../types';
import { AxiosAdapter, createAxiosAdapter } from './axios';

describe('AxiosAdapter', () => {
  let axiosInstance: AxiosInstance;
  let mockAxios: MockAdapter;
  let adapter: AxiosAdapter;

  beforeEach(() => {
    axiosInstance = axios.create({
      baseURL: 'https://api.example.com',
    });
    mockAxios = new MockAdapter(axiosInstance);
    adapter = new AxiosAdapter(axiosInstance);
  });

  afterEach(() => {
    mockAxios.reset();
  });

  describe('request', () => {
    it('should execute a successful GET request', async () => {
      const mockData = { message: 'success', id: 123 };
      mockAxios.onGet('/test').reply(200, mockData);

      const request: HttpRequest = {
        method: 'GET',
        url: '/test',
        headers: {},
      };

      const response = await adapter.request(request);

      expect(response.status).toBe(200);
      expect(response.data).toEqual(mockData);
    });

    it('should execute a POST request with body', async () => {
      const requestBody = { name: 'test', value: 42 };
      const responseData = { id: '123', created: true };

      mockAxios.onPost('/users', requestBody).reply(201, responseData);

      const request: HttpRequest = {
        method: 'POST',
        url: '/users',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      };

      const response = await adapter.request(request);

      expect(response.status).toBe(201);
      expect(response.data).toEqual(responseData);
    });

    it('should include query params', async () => {
      mockAxios.onGet('/search').reply((config) => {
        expect(config.params).toEqual({ q: 'test', limit: 10 });
        return [200, { results: [] }];
      });

      const request: HttpRequest = {
        method: 'GET',
        url: '/search',
        headers: {},
        params: { q: 'test', limit: 10 },
      };

      await adapter.request(request);
    });

    it('should handle 404 errors', async () => {
      mockAxios.onGet('/notfound').reply(404, { error: 'Not found' });

      const request: HttpRequest = {
        method: 'GET',
        url: '/notfound',
        headers: {},
      };

      await expect(adapter.request(request)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('should handle 402 payment errors', async () => {
      const paymentData = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '1000000',
            payTo: '0x1234567890123456789012345678901234567890',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
        ],
      };

      mockAxios.onGet('/premium').reply(402, paymentData);

      const request: HttpRequest = {
        method: 'GET',
        url: '/premium',
        headers: {},
      };

      await expect(adapter.request(request)).rejects.toMatchObject({
        status: 402,
      });
    });

    it('should handle network errors', async () => {
      mockAxios.onGet('/network-error').networkError();

      const request: HttpRequest = {
        method: 'GET',
        url: '/network-error',
        headers: {},
      };

      await expect(adapter.request(request)).rejects.toMatchObject({
        message: expect.stringContaining('Network Error'),
      });
    });

    it('should preserve metadata in request', async () => {
      mockAxios.onGet('/test').reply((config) => {
        expect((config as any).__sapiomInternal).toEqual({ __is402Retry: true });
        return [200, { ok: true }];
      });

      const request: HttpRequest = {
        method: 'GET',
        url: '/test',
        headers: {},
        metadata: { __is402Retry: true },
      };

      await adapter.request(request);
    });
  });

  describe('addRequestInterceptor', () => {
    it('should modify outgoing requests', async () => {
      adapter.addRequestInterceptor((request) => {
        return {
          ...request,
          headers: {
            ...request.headers,
            'X-Custom-Header': 'intercepted',
          },
        };
      });

      mockAxios.onGet('/test').reply((config) => {
        expect(config.headers?.['X-Custom-Header']).toBe('intercepted');
        return [200, { ok: true }];
      });

      await adapter.request({
        method: 'GET',
        url: '/test',
        headers: {},
      });
    });

    it('should support async interceptors', async () => {
      adapter.addRequestInterceptor(async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          ...request,
          headers: { ...request.headers, 'X-Async': 'true' },
        };
      });

      mockAxios.onGet('/test').reply((config) => {
        expect(config.headers?.['X-Async']).toBe('true');
        return [200, { ok: true }];
      });

      await adapter.request({
        method: 'GET',
        url: '/test',
        headers: {},
      });
    });

    it('should allow cleanup of interceptors', async () => {
      const interceptor = jest.fn((request) => {
        return {
          ...request,
          headers: {
            ...request.headers,
            'X-Custom-Header': 'intercepted',
          },
        };
      });
      const cleanup = adapter.addRequestInterceptor(interceptor);

      mockAxios.onGet('/test1').reply((config) => {
        expect(config.headers?.['X-Custom-Header']).toBe('intercepted');
        return [200, { ok: true }];
      });
      mockAxios.onGet('/test2').reply((config) => {
        expect(config.headers?.['X-Custom-Header']).not.toBeDefined();
        return [200, { ok: true }];
      });

      // First request - interceptor should be called
      await adapter.request({ method: 'GET', url: '/test1', headers: {} });
      expect(interceptor).toHaveBeenCalledTimes(1);

      // Clean up
      cleanup();

      // Second request - interceptor should not be called
      await adapter.request({ method: 'GET', url: '/test2', headers: {} });
      expect(interceptor).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should support multiple interceptors in order', async () => {
      const calls: string[] = [];

      adapter.addRequestInterceptor((request) => {
        calls.push('first');
        return request;
      });

      adapter.addRequestInterceptor((request) => {
        calls.push('second');
        return request;
      });

      mockAxios.onGet('/test').reply(200, {});

      await adapter.request({ method: 'GET', url: '/test', headers: {} });

      // Axios runs interceptors in reverse order (LIFO)
      expect(calls).toEqual(['second', 'first']);
    });
  });

  describe('addResponseInterceptor', () => {
    it('should modify successful responses', async () => {
      adapter.addResponseInterceptor((response) => {
        return {
          ...response,
          data: { ...response.data, modified: true },
        };
      });

      mockAxios.onGet('/test').reply(200, { original: true });

      const response = await adapter.request({
        method: 'GET',
        url: '/test',
        headers: {},
      });

      expect(response.data).toEqual({
        original: true,
        modified: true,
      });
    });

    it('should handle errors with error interceptor', async () => {
      const errorHandler = jest.fn((error) => {
        // Recover from 404 by returning a default response
        if (error.status === 404) {
          return {
            status: 200,
            statusText: 'OK',
            headers: {},
            data: { recovered: true, original404: true },
          };
        }
        throw error;
      });

      adapter.addResponseInterceptor((response) => response, errorHandler);

      mockAxios.onGet('/notfound').reply(404, { error: 'Not found' });

      const response = await adapter.request({
        method: 'GET',
        url: '/notfound',
        headers: {},
      });

      expect(errorHandler).toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ recovered: true, original404: true });
    });

    it('should properly format 402 payment errors', async () => {
      const paymentData = {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '1000000',
            resourceName: 'https://api.example.com/premium',
            payTo: '0x1234567890123456789012345678901234567890',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
        ],
      };

      const errorHandler = jest.fn();
      adapter.addResponseInterceptor((response) => response, errorHandler);

      mockAxios.onGet('/premium').reply(402, paymentData, {
        'x-payment-required': 'true',
      });

      await adapter
        .request({
          method: 'GET',
          url: '/premium',
          headers: {},
        })
        .catch(() => {});

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Request failed with status code 402',
          status: 402,
          data: paymentData,
          headers: expect.objectContaining({
            'x-payment-required': 'true',
          }),
          request: expect.objectContaining({
            method: 'get',
            url: '/premium',
          }),
          response: expect.objectContaining({
            status: 402,
            data: paymentData,
          }),
        }),
      );
    });

    it('should handle 500 server errors', async () => {
      mockAxios.onGet('/error').reply(500, { error: 'Internal server error' });

      await expect(
        adapter.request({
          method: 'GET',
          url: '/error',
          headers: {},
        }),
      ).rejects.toMatchObject({
        status: 500,
      });
    });

    it('should allow cleanup of response interceptors', async () => {
      const interceptor = jest.fn((response) => {
        return {
          ...response,
          data: { ...response.data, modified: true },
        };
      });
      const cleanup = adapter.addResponseInterceptor(interceptor);

      mockAxios.onGet('/test1').reply(200, { original: '1' });
      mockAxios.onGet('/test2').reply(200, { original: '2' });

      const repsonse1 = await adapter.request({ method: 'GET', url: '/test1', headers: {} });
      expect(repsonse1.data).toEqual({ original: '1', modified: true });
      expect(interceptor).toHaveBeenCalledTimes(1);

      cleanup();

      const response2 = await adapter.request({ method: 'GET', url: '/test2', headers: {} });
      expect(response2.data).toEqual({ original: '2' });
      expect(interceptor).toHaveBeenCalledTimes(1); // Not called after cleanup
    });

    it('should support multiple response interceptors in order', async () => {
      const calls: string[] = [];

      adapter.addResponseInterceptor((response) => {
        calls.push('first');
        return response;
      });

      adapter.addResponseInterceptor((response) => {
        calls.push('second');
        return response;
      });

      mockAxios.onGet('/test').reply(200, {});

      await adapter.request({ method: 'GET', url: '/test', headers: {} });

      expect(calls).toEqual(['first', 'second']);
    });
  });

  describe('createAxiosAdapter', () => {
    it('should create an AxiosAdapter instance', () => {
      const axiosInstance = axios.create();
      const adapter = createAxiosAdapter(axiosInstance);

      expect(adapter).toBeInstanceOf(AxiosAdapter);
    });

    it('should work with created adapter', async () => {
      const axiosInstance = axios.create({ baseURL: 'https://test.com' });
      const mockAdapter = new MockAdapter(axiosInstance);
      const adapter = createAxiosAdapter(axiosInstance);

      mockAdapter.onGet('/data').reply(200, { test: true });

      const response = await adapter.request({
        method: 'GET',
        url: '/data',
        headers: {},
      });

      expect(response.data).toEqual({ test: true });
    });
  });

  describe('metadata preservation', () => {
    it('should preserve metadata through interceptors', async () => {
      let capturedMetadata: any;

      adapter.addRequestInterceptor((request) => {
        capturedMetadata = request.metadata;
        return request;
      });

      mockAxios.onGet('/test').reply(200, {});

      await adapter.request({
        method: 'GET',
        url: '/test',
        headers: {},
        metadata: { customFlag: true, __is402Retry: false },
      });

      expect(capturedMetadata).toEqual({
        customFlag: true,
        __is402Retry: false,
      });
    });

    it('should allow modifying metadata in interceptor', async () => {
      adapter.addRequestInterceptor((request) => {
        return {
          ...request,
          metadata: {
            ...request.metadata,
            interceptorAdded: true,
          },
        };
      });

      mockAxios.onGet('/test').reply((config) => {
        expect((config as any).__sapiomInternal).toEqual({
          original: true,
          interceptorAdded: true,
        });
        return [200, {}];
      });

      await adapter.request({
        method: 'GET',
        url: '/test',
        headers: {},
        metadata: { original: true },
      });
    });

    it('should preserve __sapiom separately from internal metadata', async () => {
      adapter.addRequestInterceptor((request) => {
        expect(request.__sapiom).toEqual({ serviceName: 'test-service' });
        expect(request.metadata).toEqual({ __is402Retry: true });
        return request;
      });

      mockAxios.onGet('/test').reply(200, {});

      await adapter.request({
        method: 'GET',
        url: '/test',
        headers: {},
        __sapiom: { serviceName: 'test-service' },
        metadata: { __is402Retry: true },
      });
    });
  });

  describe('integration with Axios features', () => {
    it('should work with different HTTP methods', async () => {
      mockAxios.onPut('/resource/123').reply(200, { updated: true });
      mockAxios.onDelete('/resource/456').reply(204);
      mockAxios.onPatch('/resource/789').reply(200, { patched: true });

      const putResponse = await adapter.request({
        method: 'PUT',
        url: '/resource/123',
        headers: {},
        body: { name: 'updated' },
      });
      expect(putResponse.data).toEqual({ updated: true });

      const deleteResponse = await adapter.request({
        method: 'DELETE',
        url: '/resource/456',
        headers: {},
      });
      expect(deleteResponse.status).toBe(204);

      const patchResponse = await adapter.request({
        method: 'PATCH',
        url: '/resource/789',
        headers: {},
        body: { name: 'patched' },
      });
      expect(patchResponse.data).toEqual({ patched: true });
    });

    it('should preserve custom headers', async () => {
      mockAxios.onGet('/test').reply((config) => {
        expect(config.headers?.['Authorization']).toBe('Bearer token123');
        expect(config.headers?.['X-Custom']).toBe('value');
        return [200, {}];
      });

      await adapter.request({
        method: 'GET',
        url: '/test',
        headers: {
          Authorization: 'Bearer token123',
          'X-Custom': 'value',
        },
      });
    });

    it('should handle timeout errors', async () => {
      mockAxios.onGet('/timeout').timeout();

      await expect(
        adapter.request({
          method: 'GET',
          url: '/timeout',
          headers: {},
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('timeout'),
      });
    });
  });

  describe('error recovery with interceptors', () => {
    it('should allow interceptor to recover from 402 and retry', async () => {
      let firstCall = true;

      mockAxios.onGet('/premium').reply(() => {
        if (firstCall) {
          firstCall = false;
          return [402, { requiresPayment: true }];
        }
        return [200, { data: 'premium content' }];
      });

      // Simulate payment interceptor
      adapter.addResponseInterceptor(
        (response) => response,
        async (error) => {
          if (error.status === 402) {
            // Simulate payment handling
            const retryRequest: HttpRequest = {
              ...error.request!,
              headers: {
                ...error.request!.headers,
                'X-PAYMENT': 'payment-authorization-payload',
              },
              metadata: {
                ...error.request!.metadata,
                __is402Retry: true,
              },
            };

            // Retry the request
            return await adapter.request(retryRequest);
          }
          throw error;
        },
      );

      const response = await adapter.request({
        method: 'GET',
        url: '/premium',
        headers: {},
      });

      expect(response.status).toBe(200);
      expect(firstCall).toBe(false);
      expect(response.data).toEqual({ data: 'premium content' });
    });

    it('should prevent infinite retry loops', async () => {
      mockAxios.onGet('/premium').reply(402, { requiresPayment: true });

      let retryCount = 0;

      adapter.addResponseInterceptor(
        (response) => response,
        async (error) => {
          if (error.status === 402 && !error.request?.metadata?.__is402Retry) {
            retryCount++;

            // Try to retry with flag set
            const retryRequest: HttpRequest = {
              ...error.request!,
              metadata: { __is402Retry: true },
            };

            return await adapter.request(retryRequest);
          }
          throw error;
        },
      );

      await expect(
        adapter.request({
          method: 'GET',
          url: '/premium',
          headers: {},
        }),
      ).rejects.toMatchObject({
        status: 402,
      });

      // Should only retry once
      expect(retryCount).toBe(1);
    });
  });
});
