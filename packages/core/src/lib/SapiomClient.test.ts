import { SapiomClient } from "./SapiomClient";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe("SapiomClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("initialization", () => {
    it("should initialize with required config", () => {
      const client = new SapiomClient({
        apiKey: "test-api-key",
        baseURL: "https://api.test.com",
      });

      expect(client).toBeDefined();
      expect(client.transactions).toBeDefined();
    });

    it("should throw error when API key is missing", () => {
      expect(() => {
        new SapiomClient({
          apiKey: "",
        });
      }).toThrow("API key is required");
    });

    it("should use default baseURL when not provided", () => {
      const client = new SapiomClient({
        apiKey: "test-api-key",
      });

      const httpClient = client.getHttpClient();
      expect(httpClient.defaults.baseURL).toBe("http://localhost:3000");
    });

    it("should update API key", () => {
      const client = new SapiomClient({
        apiKey: "test-api-key",
      });

      client.setApiKey("new-api-key");
      const httpClient = client.getHttpClient();
      expect(httpClient.defaults.headers["x-api-key"]).toBe("new-api-key");
    });
  });

  describe("request method - response parsing", () => {
    let client: SapiomClient;

    beforeEach(() => {
      client = new SapiomClient({
        apiKey: "test-api-key",
        baseURL: "https://api.test.com",
      });
    });

    it("should parse JSON responses with application/json content-type", async () => {
      const mockData = { message: "success", count: 42 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue(mockData),
        text: jest.fn().mockResolvedValue(JSON.stringify(mockData)),
      });

      const result = await client.request({ url: "/test" });

      expect(result).toEqual(mockData);
      expect(typeof result).toBe("object");
    });

    it("should parse text responses with text/plain content-type", async () => {
      const mockText = "Hello, World!";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "text/plain" : null,
        },
        json: jest.fn().mockRejectedValue(new Error("Not JSON")),
        text: jest.fn().mockResolvedValue(mockText),
      });

      const result = await client.request({ url: "/test" });

      expect(result).toBe(mockText);
      expect(typeof result).toBe("string");
    });

    it("should parse text responses with text/html content-type", async () => {
      const mockHtml = "<html><body>Test</body></html>";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === "content-type" ? "text/html" : null),
        },
        json: jest.fn().mockRejectedValue(new Error("Not JSON")),
        text: jest.fn().mockResolvedValue(mockHtml),
      });

      const result = await client.request({ url: "/test" });

      expect(result).toBe(mockHtml);
      expect(typeof result).toBe("string");
    });

    it("should handle empty responses", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: {
          get: () => null,
        },
        json: jest.fn().mockRejectedValue(new Error("No content")),
        text: jest.fn().mockResolvedValue(""),
      });

      const result = await client.request({ url: "/test" });

      expect(result).toBeNull();
    });

    it("should parse JSON-like responses without content-type", async () => {
      const mockData = { success: true };
      const mockText = JSON.stringify(mockData);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: () => null,
        },
        json: jest.fn().mockResolvedValue(mockData),
        text: jest.fn().mockResolvedValue(mockText),
      });

      const result = await client.request({ url: "/test" });

      expect(result).toEqual(mockData);
    });

    it("should handle invalid JSON in application/json response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockRejectedValue(new Error("Invalid JSON")),
        text: jest.fn().mockResolvedValue("not valid json"),
      });

      const result = await client.request({ url: "/test" });

      // Should return empty object for invalid JSON with JSON content-type
      expect(result).toEqual({});
    });

    it("should handle plain text without content-type", async () => {
      const mockText = "plain text response";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: () => null,
        },
        json: jest.fn().mockRejectedValue(new Error("Not JSON")),
        text: jest.fn().mockResolvedValue(mockText),
      });

      const result = await client.request({ url: "/test" });

      expect(result).toBe(mockText);
      expect(typeof result).toBe("string");
    });

    it("should handle error responses with JSON content", async () => {
      const errorData = { error: "Bad Request", message: "Invalid input" };
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue(errorData),
        text: jest.fn().mockResolvedValue(JSON.stringify(errorData)),
      });

      await expect(client.request({ url: "/test" })).rejects.toThrow(
        /Request failed with status 400/,
      );
    });

    it("should handle error responses with text content", async () => {
      const errorText = "Internal Server Error";
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "text/plain" : null,
        },
        json: jest.fn().mockRejectedValue(new Error("Not JSON")),
        text: jest.fn().mockResolvedValue(errorText),
      });

      await expect(client.request({ url: "/test" })).rejects.toThrow(
        /Request failed with status 500/,
      );
    });

    it("should handle timeout", async () => {
      jest.useFakeTimers();

      const client = new SapiomClient({
        apiKey: "test-api-key",
        baseURL: "https://api.test.com",
        timeout: 100,
      });

      // Mock fetch that respects AbortController
      mockFetch.mockImplementation(
        (url, options) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve({
                ok: true,
                status: 200,
                headers: {
                  get: (name: string) =>
                    name === "content-type" ? "application/json" : null,
                },
                json: jest.fn().mockResolvedValue({}),
              });
            }, 200);

            // Listen for abort signal
            if (options?.signal) {
              options.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                const error: any = new Error("The operation was aborted");
                error.name = "AbortError";
                reject(error);
              });
            }
          }),
      );

      const requestPromise = client.request({ url: "/test" });

      // Fast-forward time past timeout
      jest.advanceTimersByTime(101);

      await expect(requestPromise).rejects.toThrow(/Request timeout/);

      jest.useRealTimers();
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(client.request({ url: "/test" })).rejects.toThrow(
        "Network error",
      );
    });

    it("should build URLs with query parameters", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({ success: true }),
        text: jest.fn().mockResolvedValue('{"success":true}'),
      });

      await client.request({
        url: "/test",
        params: { foo: "bar", num: 123 },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.test.com/test?foo=bar&num=123",
        expect.any(Object),
      );
    });

    it("should handle POST requests with body", async () => {
      const mockBody = { name: "test", value: 42 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({ id: "123" }),
        text: jest.fn().mockResolvedValue('{"id":"123"}'),
      });

      await client.request({
        url: "/test",
        method: "POST",
        body: mockBody,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.test.com/test",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(mockBody),
        }),
      );
    });

    it("should merge custom headers with defaults", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue("{}"),
      });

      await client.request({
        url: "/test",
        headers: { "X-Custom-Header": "custom-value" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-api-key": "test-api-key",
            "Content-Type": "application/json",
            "X-Custom-Header": "custom-value",
          }),
        }),
      );
    });
  });

  describe("request body handling", () => {
    let client: SapiomClient;

    beforeEach(() => {
      client = new SapiomClient({
        apiKey: "test-api-key",
        baseURL: "https://api.test.com",
      });
    });

    it("should stringify object bodies", async () => {
      const mockBody = { name: "test", value: 42 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({ id: "123" }),
        text: jest.fn().mockResolvedValue('{"id":"123"}'),
      });

      await client.request({
        url: "/test",
        method: "POST",
        body: mockBody,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify(mockBody),
        }),
      );
    });

    it("should not double-encode pre-stringified JSON", async () => {
      const mockData = { name: "test", value: 42 };
      const prestringified = JSON.stringify(mockData);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({ id: "123" }),
        text: jest.fn().mockResolvedValue('{"id":"123"}'),
      });

      await client.request({
        url: "/test",
        method: "POST",
        body: prestringified,
      });

      // Should pass string as-is, not stringify it again
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: prestringified,
        }),
      );
    });

    it("should handle FormData bodies without stringifying", async () => {
      const formData = new FormData();
      formData.append("file", "test-content");
      formData.append("name", "test-file");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({ success: true }),
        text: jest.fn().mockResolvedValue('{"success":true}'),
      });

      await client.request({
        url: "/upload",
        method: "POST",
        body: formData,
      });

      // Should pass FormData as-is
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: formData,
        }),
      );
    });

    it("should handle URLSearchParams bodies without stringifying", async () => {
      const params = new URLSearchParams();
      params.append("key1", "value1");
      params.append("key2", "value2");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({ success: true }),
        text: jest.fn().mockResolvedValue('{"success":true}'),
      });

      await client.request({
        url: "/form",
        method: "POST",
        body: params,
      });

      // Should pass URLSearchParams as-is
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: params,
        }),
      );
    });

    it("should handle Blob bodies without stringifying", async () => {
      const blob = new Blob(["test content"], { type: "text/plain" });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({ success: true }),
        text: jest.fn().mockResolvedValue('{"success":true}'),
      });

      await client.request({
        url: "/upload",
        method: "POST",
        body: blob,
      });

      // Should pass Blob as-is
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: blob,
        }),
      );
    });

    it("should handle ArrayBuffer bodies without stringifying", async () => {
      const buffer = new ArrayBuffer(8);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({ success: true }),
        text: jest.fn().mockResolvedValue('{"success":true}'),
      });

      await client.request({
        url: "/binary",
        method: "POST",
        body: buffer,
      });

      // Should pass ArrayBuffer as-is
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: buffer,
        }),
      );
    });

    it("should handle null body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue("{}"),
      });

      await client.request({
        url: "/test",
        method: "POST",
        body: null,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: undefined,
        }),
      );
    });

    it("should handle undefined body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue("{}"),
      });

      await client.request({
        url: "/test",
        method: "GET",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: undefined,
        }),
      );
    });
  });
});
