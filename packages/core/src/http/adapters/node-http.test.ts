import nock from 'nock';

import { HttpRequest } from '../types';
import { NodeHttpAdapter, createNodeHttpAdapter } from './node-http';

describe('NodeHttpAdapter', () => {
  let adapter: NodeHttpAdapter;
  const baseURL = 'https://api.example.com';

  beforeEach(() => {
    adapter = new NodeHttpAdapter();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('request', () => {
    it('should execute a successful GET request', async () => {
      const mockData = { message: 'success', id: 123 };
      nock(baseURL).get('/test').reply(200, mockData);

      const request: HttpRequest = {
        method: 'GET',
        url: `${baseURL}/test`,
        headers: {},
      };

      const response = await adapter.request(request);

      expect(response.status).toBe(200);
      expect(response.data).toEqual(mockData);
    });

    it('should execute a POST request with body', async () => {
      const requestBody = { name: 'test', value: 42 };
      const responseData = { id: '123', created: true };

      nock(baseURL).post('/users', requestBody).reply(201, responseData);

      const request: HttpRequest = {
        method: 'POST',
        url: `${baseURL}/users`,
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      };

      const response = await adapter.request(request);

      expect(response.status).toBe(201);
      expect(response.data).toEqual(responseData);
    });

    it('should include query params', async () => {
      nock(baseURL).get('/search').query({ q: 'test', limit: 10 }).reply(200, { results: [] });

      const request: HttpRequest = {
        method: 'GET',
        url: `${baseURL}/search`,
        headers: {},
        params: { q: 'test', limit: 10 },
      };

      const response = await adapter.request(request);

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ results: [] });
    });

    it('should handle 404 errors', async () => {
      nock(baseURL).get('/notfound').reply(404, { error: 'Not found' });

      const request: HttpRequest = {
        method: 'GET',
        url: `${baseURL}/notfound`,
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
            resourceName: 'https://api.example.com/premium',
            payTo: '0x1234567890123456789012345678901234567890',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
        ],
      };

      nock(baseURL).get('/premium').reply(402, paymentData, {
        'x-payment-required': 'true',
      });

      const request: HttpRequest = {
        method: 'GET',
        url: `${baseURL}/premium`,
        headers: {},
      };

      await expect(adapter.request(request)).rejects.toMatchObject({
        status: 402,
      });
    });

    it('should handle network errors', async () => {
      nock(baseURL).get('/network-error').replyWithError('Network Error');

      const request: HttpRequest = {
        method: 'GET',
        url: `${baseURL}/network-error`,
        headers: {},
      };

      await expect(adapter.request(request)).rejects.toMatchObject({
        message: expect.stringContaining('Network Error'),
      });
    });

    it('should handle text responses', async () => {
      nock(baseURL).get('/text').reply(200, 'plain text response', { 'content-type': 'text/plain' });

      const request: HttpRequest = {
        method: 'GET',
        url: `${baseURL}/text`,
        headers: {},
      };

      const response = await adapter.request(request);

      expect(response.data).toBe('plain text response');
    });

    it('should handle HTTPS requests', async () => {
      nock('https://secure-api.com').get('/secure').reply(200, { secure: true });

      const request: HttpRequest = {
        method: 'GET',
        url: 'https://secure-api.com/secure',
        headers: {},
      };

      const response = await adapter.request(request);

      expect(response.data).toEqual({ secure: true });
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

      nock(baseURL).get('/test').matchHeader('X-Custom-Header', 'intercepted').reply(200, { ok: true });

      await adapter.request({
        method: 'GET',
        url: `${baseURL}/test`,
        headers: {},
      });

      // Verify nock matched the header
      expect(nock.isDone()).toBe(true);
    });

    it('should support async interceptors', async () => {
      adapter.addRequestInterceptor(async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          ...request,
          headers: { ...request.headers, 'X-Async': 'true' },
        };
      });

      nock(baseURL).get('/test').matchHeader('X-Async', 'true').reply(200, { ok: true });

      await adapter.request({
        method: 'GET',
        url: `${baseURL}/test`,
        headers: {},
      });

      expect(nock.isDone()).toBe(true);
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

      // First request - should have the header
      nock(baseURL).get('/test1').matchHeader('X-Custom-Header', 'intercepted').reply(200, { ok: true });

      await adapter.request({ method: 'GET', url: `${baseURL}/test1`, headers: {} });
      expect(interceptor).toHaveBeenCalledTimes(1);

      // Clean up
      cleanup();

      // Second request - should NOT have the header
      nock(baseURL)
        .get('/test2')
        .matchHeader('X-Custom-Header', (val) => val === undefined)
        .reply(200, { ok: true });

      await adapter.request({ method: 'GET', url: `${baseURL}/test2`, headers: {} });
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

      nock(baseURL).get('/test').reply(200, {});

      await adapter.request({ method: 'GET', url: `${baseURL}/test`, headers: {} });

      expect(calls).toEqual(['first', 'second']);
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

      nock(baseURL).get('/test').reply(200, { original: true });

      const response = await adapter.request({
        method: 'GET',
        url: `${baseURL}/test`,
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

      nock(baseURL).get('/notfound').reply(404, { error: 'Not found' });

      const response = await adapter.request({
        method: 'GET',
        url: `${baseURL}/notfound`,
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

      nock(baseURL).get('/premium').reply(402, paymentData, {
        'x-payment-required': 'true',
      });

      await adapter
        .request({
          method: 'GET',
          url: `${baseURL}/premium`,
          headers: {},
        })
        .catch(() => {});

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 402,
          data: paymentData,
          headers: expect.objectContaining({
            'x-payment-required': 'true',
          }),
          request: expect.objectContaining({
            method: 'GET',
            url: `${baseURL}/premium`,
          }),
        }),
      );
    });

    it('should handle 500 server errors', async () => {
      nock(baseURL).get('/error').reply(500, { error: 'Internal server error' });

      await expect(
        adapter.request({
          method: 'GET',
          url: `${baseURL}/error`,
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

      nock(baseURL).get('/test1').reply(200, { original: '1' });
      nock(baseURL).get('/test2').reply(200, { original: '2' });

      const response1 = await adapter.request({
        method: 'GET',
        url: `${baseURL}/test1`,
        headers: {},
      });
      expect(response1.data).toEqual({ original: '1', modified: true });
      expect(interceptor).toHaveBeenCalledTimes(1);

      cleanup();

      const response2 = await adapter.request({
        method: 'GET',
        url: `${baseURL}/test2`,
        headers: {},
      });
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

      nock(baseURL).get('/test').reply(200, {});

      await adapter.request({ method: 'GET', url: `${baseURL}/test`, headers: {} });

      expect(calls).toEqual(['first', 'second']);
    });
  });

  describe('createNodeHttpAdapter', () => {
    it('should create a NodeHttpAdapter instance', () => {
      const adapter = createNodeHttpAdapter();
      expect(adapter).toBeInstanceOf(NodeHttpAdapter);
    });

    it('should work with created adapter', async () => {
      const adapter = createNodeHttpAdapter();

      nock('https://test.com').get('/data').reply(200, { test: true });

      const response = await adapter.request({
        method: 'GET',
        url: 'https://test.com/data',
        headers: {},
      });

      expect(response.data).toEqual({ test: true });
    });
  });

  describe('integration with Node HTTP features', () => {
    it('should work with different HTTP methods', async () => {
      nock(baseURL).put('/resource/123').reply(200, { updated: true });
      nock(baseURL).delete('/resource/456').reply(204);
      nock(baseURL).patch('/resource/789').reply(200, { patched: true });

      const putResponse = await adapter.request({
        method: 'PUT',
        url: `${baseURL}/resource/123`,
        headers: {},
        body: { name: 'updated' },
      });
      expect(putResponse.data).toEqual({ updated: true });

      const deleteResponse = await adapter.request({
        method: 'DELETE',
        url: `${baseURL}/resource/456`,
        headers: {},
      });
      expect(deleteResponse.status).toBe(204);

      const patchResponse = await adapter.request({
        method: 'PATCH',
        url: `${baseURL}/resource/789`,
        headers: {},
        body: { name: 'patched' },
      });
      expect(patchResponse.data).toEqual({ patched: true });
    });

    it('should preserve custom headers', async () => {
      nock(baseURL)
        .get('/test')
        .matchHeader('Authorization', 'Bearer token123')
        .matchHeader('X-Custom', 'value')
        .reply(200, {});

      await adapter.request({
        method: 'GET',
        url: `${baseURL}/test`,
        headers: {
          Authorization: 'Bearer token123',
          'X-Custom': 'value',
        },
      });

      expect(nock.isDone()).toBe(true);
    });

    it('should handle non-JSON responses gracefully', async () => {
      nock(baseURL).get('/html').reply(200, '<html>test</html>', { 'content-type': 'text/html' });

      const response = await adapter.request({
        method: 'GET',
        url: `${baseURL}/html`,
        headers: {},
      });

      expect(response.data).toBe('<html>test</html>');
    });

    it('should work with both HTTP and HTTPS', async () => {
      nock('http://insecure-api.com').get('/data').reply(200, { http: true });
      nock('https://secure-api.com').get('/data').reply(200, { https: true });

      const httpResponse = await adapter.request({
        method: 'GET',
        url: 'http://insecure-api.com/data',
        headers: {},
      });
      expect(httpResponse.data).toEqual({ http: true });

      const httpsResponse = await adapter.request({
        method: 'GET',
        url: 'https://secure-api.com/data',
        headers: {},
      });
      expect(httpsResponse.data).toEqual({ https: true });
    });
  });

  describe('error recovery with interceptors', () => {
    it('should allow interceptor to recover from 402 and retry', async () => {
      let firstCall = true;

      nock(baseURL)
        .get('/premium')
        .times(2)
        .reply(() => {
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
          if (error.status === 402 && !error.request?.metadata?.__is402Retry) {
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
        url: `${baseURL}/premium`,
        headers: {},
      });

      expect(response.status).toBe(200);
      expect(firstCall).toBe(false);
      expect(response.data).toEqual({ data: 'premium content' });
    });

    it('should prevent infinite retry loops', async () => {
      let retryCount = 0;

      nock(baseURL).get('/premium').times(2).reply(402, { requiresPayment: true });

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
          url: `${baseURL}/premium`,
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
