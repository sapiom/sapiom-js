import fetchMock from "@fetch-mock/jest";

import { HttpRequest } from "@sapiom/core";
import { FetchAdapter, createFetchAdapter } from "./adapter";

describe("FetchAdapter", () => {
  let adapter: FetchAdapter;
  const baseURL = "https://api.example.com";

  beforeAll(() => {
    fetchMock.mockGlobal();
  });

  beforeEach(() => {
    adapter = new FetchAdapter(baseURL);
    fetchMock.clearHistory();
  });

  afterEach(() => {
    fetchMock.removeRoutes();
  });

  afterAll(() => {
    fetchMock.unmockGlobal();
  });

  describe("request", () => {
    it("should execute a successful GET request", async () => {
      const mockData = { message: "success", id: 123 };
      fetchMock.route(`${baseURL}/test`, {
        status: 200,
        body: mockData,
      });

      const request: HttpRequest = {
        method: "GET",
        url: "/test",
        headers: {},
      };

      const response = await adapter.request(request);

      expect(response.status).toBe(200);
      expect(response.data).toEqual(mockData);
    });

    it("should execute a POST request with body", async () => {
      const requestBody = { name: "test", value: 42 };
      const responseData = { id: "123", created: true };

      fetchMock.route(
        `${baseURL}/users`,
        {
          status: 201,
          body: responseData,
        },
        {
          method: "POST",
        },
      );

      const request: HttpRequest = {
        method: "POST",
        url: "/users",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      };

      const response = await adapter.request(request);

      expect(response.status).toBe(201);
      expect(response.data).toEqual(responseData);
    });

    it("should handle 404 errors", async () => {
      fetchMock.route(`${baseURL}/notfound`, {
        status: 404,
        body: { error: "Not found" },
      });

      const request: HttpRequest = {
        method: "GET",
        url: "/notfound",
        headers: {},
      };

      await expect(adapter.request(request)).rejects.toMatchObject({
        status: 404,
      });
    });

    it("should handle 402 payment errors", async () => {
      const paymentData = {
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base-sepolia",
            maxAmountRequired: "1000000",
            resourceName: "https://api.example.com/premium",
            payTo: "0x1234567890123456789012345678901234567890",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          },
        ],
      };

      fetchMock.route(`${baseURL}/premium`, {
        status: 402,
        body: paymentData,
        headers: {
          "x-payment-required": "true",
        },
      });

      const request: HttpRequest = {
        method: "GET",
        url: "/premium",
        headers: {},
      };

      await expect(adapter.request(request)).rejects.toMatchObject({
        status: 402,
      });
    });

    it("should handle network errors", async () => {
      fetchMock.route(`${baseURL}/network-error`, {
        throws: new Error("Network Error"),
      });

      const request: HttpRequest = {
        method: "GET",
        url: "/network-error",
        headers: {},
      };

      await expect(adapter.request(request)).rejects.toMatchObject({
        message: expect.stringContaining("Network Error"),
      });
    });

    it("should handle absolute URLs", async () => {
      const absoluteURL = "https://other-api.com/data";
      fetchMock.route(absoluteURL, {
        status: 200,
        body: { absolute: true },
      });

      const request: HttpRequest = {
        method: "GET",
        url: absoluteURL,
        headers: {},
      };

      const response = await adapter.request(request);

      expect(response.data).toEqual({ absolute: true });
    });

    it("should handle text responses", async () => {
      fetchMock.route(`${baseURL}/text`, {
        status: 200,
        body: "plain text response",
        headers: { "content-type": "text/plain" },
      });

      const request: HttpRequest = {
        method: "GET",
        url: "/text",
        headers: {},
      };

      const response = await adapter.request(request);

      expect(response.data).toBe("plain text response");
    });
  });

  describe("addRequestInterceptor", () => {
    it("should modify outgoing requests", async () => {
      adapter.addRequestInterceptor((request) => {
        return {
          ...request,
          headers: {
            ...request.headers,
            "X-Custom-Header": "intercepted",
          },
        };
      });

      fetchMock.route(`${baseURL}/test`, {
        status: 200,
        body: { ok: true },
      });

      await adapter.request({
        method: "GET",
        url: "/test",
        headers: {},
      });

      const calls = fetchMock.callHistory.calls();
      expect(calls).toHaveLength(1);
      expect((calls[0]!.options!.headers as any)["x-custom-header"]).toBe(
        "intercepted",
      );
    });

    it("should support async interceptors", async () => {
      adapter.addRequestInterceptor(async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          ...request,
          headers: { ...request.headers, "X-Async": "true" },
        };
      });

      fetchMock.route(`${baseURL}/test`, {
        status: 200,
        body: { ok: true },
      });

      await adapter.request({
        method: "GET",
        url: "/test",
        headers: {},
      });

      // Verify async interceptor added the header (headers are lowercase in callHistory)
      const calls = fetchMock.callHistory.calls();
      expect(calls).toHaveLength(1);
      expect((calls[0]!.options!.headers as any)["x-async"]).toBe("true");
    });

    it("should allow cleanup of interceptors", async () => {
      const interceptor = jest.fn((request) => {
        return {
          ...request,
          headers: {
            ...request.headers,
            "X-Custom-Header": "intercepted",
          },
        };
      });

      const cleanup = adapter.addRequestInterceptor(interceptor);

      fetchMock.route(
        `begin:${baseURL}/test`,
        { status: 200, body: {} },
        { repeat: 2 },
      );

      // First request - interceptor should be called
      await adapter.request({ method: "GET", url: "/test1", headers: {} });
      expect(interceptor).toHaveBeenCalledTimes(1);

      // Verify header was added (headers are lowercase in callHistory)
      let calls = fetchMock.callHistory.calls();
      expect((calls[0]!.options!.headers as any)["x-custom-header"]).toBe(
        "intercepted",
      );

      // Clean up
      cleanup();

      // Second request - interceptor should not be called
      await adapter.request({ method: "GET", url: "/test2", headers: {} });
      expect(interceptor).toHaveBeenCalledTimes(1); // Still 1 - not called again

      // Verify header was NOT added after cleanup
      calls = fetchMock.callHistory.calls();
      expect(
        (calls[1]!.options!.headers as any)["x-custom-header"],
      ).toBeUndefined();
    });

    it("should support multiple interceptors in order", async () => {
      const calls: string[] = [];

      adapter.addRequestInterceptor((request) => {
        calls.push("first");
        return request;
      });

      adapter.addRequestInterceptor((request) => {
        calls.push("second");
        return request;
      });

      fetchMock.route(`${baseURL}/test`, { status: 200, body: {} });

      await adapter.request({ method: "GET", url: "/test", headers: {} });

      expect(calls).toEqual(["first", "second"]);
    });
  });

  describe("addResponseInterceptor", () => {
    it("should modify successful responses", async () => {
      adapter.addResponseInterceptor((response) => {
        return {
          ...response,
          data: { ...response.data, modified: true },
        };
      });

      fetchMock.route(`${baseURL}/test`, {
        status: 200,
        body: { original: true },
      });

      const response = await adapter.request({
        method: "GET",
        url: "/test",
        headers: {},
      });

      expect(response.data).toEqual({
        original: true,
        modified: true,
      });
    });

    it("should handle errors with error interceptor", async () => {
      const errorHandler = jest.fn((error) => {
        // Recover from 404 by returning a default response
        if (error.status === 404) {
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            data: { recovered: true, original404: true },
          };
        }
        throw error;
      });

      adapter.addResponseInterceptor((response) => response, errorHandler);

      fetchMock.route(`${baseURL}/notfound`, {
        status: 404,
        body: { error: "Not found" },
      });

      const response = await adapter.request({
        method: "GET",
        url: "/notfound",
        headers: {},
      });

      expect(errorHandler).toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ recovered: true, original404: true });
    });

    it("should properly format 402 payment errors", async () => {
      const paymentData = {
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base-sepolia",
            maxAmountRequired: "1000000",
            resourceName: "https://api.example.com/premium",
            payTo: "0x1234567890123456789012345678901234567890",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          },
        ],
      };

      const errorHandler = jest.fn();
      adapter.addResponseInterceptor((response) => response, errorHandler);

      fetchMock.route(`${baseURL}/premium`, {
        status: 402,
        body: paymentData,
        headers: {
          "x-payment-required": "true",
        },
      });

      await adapter
        .request({
          method: "GET",
          url: "/premium",
          headers: {},
        })
        .catch(() => {});

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 402,
          data: paymentData,
          request: expect.objectContaining({
            method: "GET",
            url: "/premium",
          }),
        }),
      );
    });

    it("should handle 500 server errors", async () => {
      fetchMock.route(`${baseURL}/error`, {
        status: 500,
        body: { error: "Internal server error" },
      });

      await expect(
        adapter.request({
          method: "GET",
          url: "/error",
          headers: {},
        }),
      ).rejects.toMatchObject({
        status: 500,
      });
    });

    it("should allow cleanup of response interceptors", async () => {
      const interceptor = jest.fn((response) => {
        return {
          ...response,
          data: { ...response.data, modified: true },
        };
      });

      const cleanup = adapter.addResponseInterceptor(interceptor);

      fetchMock.route(`${baseURL}/test1`, {
        status: 200,
        body: { original: "1" },
      });
      fetchMock.route(`${baseURL}/test2`, {
        status: 200,
        body: { original: "2" },
      });

      const response1 = await adapter.request({
        method: "GET",
        url: "/test1",
        headers: {},
      });
      expect(response1.data).toEqual({ original: "1", modified: true });
      expect(interceptor).toHaveBeenCalledTimes(1);

      cleanup();

      const response2 = await adapter.request({
        method: "GET",
        url: "/test2",
        headers: {},
      });
      expect(response2.data).toEqual({ original: "2" });
      expect(interceptor).toHaveBeenCalledTimes(1); // Not called after cleanup
    });

    it("should support multiple response interceptors in order", async () => {
      const calls: string[] = [];

      adapter.addResponseInterceptor((response) => {
        calls.push("first");
        return response;
      });

      adapter.addResponseInterceptor((response) => {
        calls.push("second");
        return response;
      });

      fetchMock.route(`${baseURL}/test`, { status: 200, body: {} });

      await adapter.request({ method: "GET", url: "/test", headers: {} });

      expect(calls).toEqual(["first", "second"]);
    });
  });

  describe("createFetchAdapter", () => {
    it("should create a FetchAdapter instance", () => {
      const adapter = createFetchAdapter("https://test.com");
      expect(adapter).toBeInstanceOf(FetchAdapter);
    });

    it("should work with created adapter", async () => {
      const adapter = createFetchAdapter("https://test.com");

      fetchMock.route("https://test.com/data", {
        status: 200,
        body: { test: true },
      });

      const response = await adapter.request({
        method: "GET",
        url: "/data",
        headers: {},
      });

      expect(response.data).toEqual({ test: true });
    });
  });

  describe("integration with Fetch features", () => {
    it("should work with different HTTP methods", async () => {
      fetchMock.route(
        `${baseURL}/resource/123`,
        { status: 200, body: { updated: true } },
        { method: "PUT" },
      );
      fetchMock.route(
        `${baseURL}/resource/456`,
        { status: 200, body: "" },
        { method: "DELETE" },
      ); // 204 not allowed with body
      fetchMock.route(
        `${baseURL}/resource/789`,
        { status: 200, body: { patched: true } },
        { method: "PATCH" },
      );

      const putResponse = await adapter.request({
        method: "PUT",
        url: "/resource/123",
        headers: {},
        body: { name: "updated" },
      });
      expect(putResponse.data).toEqual({ updated: true });

      const deleteResponse = await adapter.request({
        method: "DELETE",
        url: "/resource/456",
        headers: {},
      });
      expect(deleteResponse.status).toBe(200);

      const patchResponse = await adapter.request({
        method: "PATCH",
        url: "/resource/789",
        headers: {},
        body: { name: "patched" },
      });
      expect(patchResponse.data).toEqual({ patched: true });
    });

    it("should handle non-JSON responses gracefully", async () => {
      fetchMock.route(`${baseURL}/html`, {
        status: 200,
        body: "<html>test</html>",
        headers: { "content-type": "text/html" },
      });

      const response = await adapter.request({
        method: "GET",
        url: "/html",
        headers: {},
      });

      expect(response.data).toBe("<html>test</html>");
    });
  });

  describe("error recovery with interceptors", () => {
    it("should allow interceptor to recover from 402 and retry", async () => {
      let callCount = 0;

      fetchMock.route(
        `${baseURL}/premium`,
        () => {
          callCount++;
          if (callCount === 1) {
            return {
              status: 402,
              body: { requiresPayment: true },
            };
          }
          return {
            status: 200,
            body: { data: "premium content" },
          };
        },
        { repeat: 2 },
      );

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
                "X-PAYMENT": "payment-authorization-payload",
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
        method: "GET",
        url: "/premium",
        headers: {},
      });

      expect(response.status).toBe(200);
      expect(callCount).toBe(2);
      expect(response.data).toEqual({ data: "premium content" });
    });

    it("should prevent infinite retry loops", async () => {
      let retryCount = 0;

      fetchMock.route(
        `${baseURL}/premium`,
        {
          status: 402,
          body: { requiresPayment: true },
        },
        { repeat: 2 },
      );

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
          method: "GET",
          url: "/premium",
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
