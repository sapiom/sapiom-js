import type { HttpClient } from "./HttpClient";
import { VaultAPI } from "./VaultAPI";

describe("VaultAPI", () => {
  let requestMock: jest.Mock;
  let api: VaultAPI;

  beforeEach(() => {
    requestMock = jest.fn();
    api = new VaultAPI({ request: requestMock } as unknown as HttpClient);
  });

  it("gets all secrets for a ref", async () => {
    requestMock.mockResolvedValueOnce({ OPENAI_API_KEY: "sk-test" });

    const result = await api.getAll("agent-123");

    expect(result).toEqual({ OPENAI_API_KEY: "sk-test" });
    expect(requestMock).toHaveBeenCalledWith({
      method: "GET",
      url: "/v2/secrets/agent-123",
    });
  });

  it("gets a subset of secrets with comma-joined keys", async () => {
    requestMock.mockResolvedValueOnce({ A: "1", B: "2" });

    const result = await api.getMany("agent-123", ["A", "B"]);

    expect(result).toEqual({ A: "1", B: "2" });
    expect(requestMock).toHaveBeenCalledWith({
      method: "GET",
      url: "/v2/secrets/agent-123",
      params: { keys: "A,B" },
    });
  });

  it("sends an empty keys parameter for empty subset requests", async () => {
    requestMock.mockResolvedValueOnce({});

    const result = await api.getMany("agent-123", []);

    expect(result).toEqual({});
    expect(requestMock).toHaveBeenCalledWith({
      method: "GET",
      url: "/v2/secrets/agent-123",
      params: { keys: "" },
    });
  });

  it("gets one secret value", async () => {
    requestMock.mockResolvedValueOnce({
      key: "OPENAI_API_KEY",
      value: "sk-test",
    });

    const result = await api.get("agent-123", "OPENAI_API_KEY");

    expect(result).toBe("sk-test");
    expect(requestMock).toHaveBeenCalledWith({
      method: "GET",
      url: "/v2/secrets/agent-123/OPENAI_API_KEY",
    });
  });

  it("returns null when one secret is not found", async () => {
    requestMock.mockRejectedValueOnce(
      new Error('Request failed with status 404: {"error":"Not Found"}'),
    );

    await expect(api.get("agent-123", "MISSING")).resolves.toBeNull();
  });

  it("rethrows non-404 errors for one secret reads", async () => {
    const error = new Error(
      'Request failed with status 400: {"error":"Bad Request"}',
    );
    requestMock.mockRejectedValueOnce(error);

    await expect(api.get("agent-123", "BAD")).rejects.toBe(error);
  });

  it("sets many secrets by merging entries", async () => {
    requestMock.mockResolvedValueOnce(null);
    const entries = {
      OPENAI_API_KEY: { value: "sk-test" },
    };

    await api.setMany("agent-123", entries);

    expect(requestMock).toHaveBeenCalledWith({
      method: "POST",
      url: "/v2/secrets/agent-123",
      body: { entries },
    });
  });

  it("sets one secret", async () => {
    requestMock.mockResolvedValueOnce(null);
    const input = { value: "sk-test" };

    await api.set("agent-123", "OPENAI_API_KEY", input);

    expect(requestMock).toHaveBeenCalledWith({
      method: "PUT",
      url: "/v2/secrets/agent-123/OPENAI_API_KEY",
      body: input,
    });
  });

  it("deletes one secret key", async () => {
    requestMock.mockResolvedValueOnce(null);

    await api.deleteKey("agent-123", "OPENAI_API_KEY");

    expect(requestMock).toHaveBeenCalledWith({
      method: "DELETE",
      url: "/v2/secrets/agent-123/OPENAI_API_KEY",
    });
  });

  it("encodes refs and keys in path segments", async () => {
    requestMock.mockResolvedValueOnce({
      key: "OPEN AI",
      value: "sk-test",
    });

    await api.get("agent/123", "OPEN AI");

    expect(requestMock).toHaveBeenCalledWith({
      method: "GET",
      url: "/v2/secrets/agent%2F123/OPEN%20AI",
    });
  });
});
