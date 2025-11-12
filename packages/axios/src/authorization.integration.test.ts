/**
 * Integration tests for AuthorizationHandler with Axios adapter
 * Tests the complete authorization flow
 */
import axios from "axios";
import MockAdapter from "axios-mock-adapter";

import { createAxiosAdapter } from "./adapter";
import {
  SapiomClient,
  TransactionAPI,
  TransactionStatus,
  AuthorizationDeniedError,
  withAuthorizationHandling,
} from "@sapiom/core";

describe("Axios Authorization Integration", () => {
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

  it("should authorize request and add transaction ID header", async () => {
    const axiosInstance = axios.create({ baseURL: "https://api.example.com" });
    const mockAxios = new MockAdapter(axiosInstance);
    const adapter = createAxiosAdapter(axiosInstance);

    const authCallbacks = {
      onAuthorizationPending: jest.fn(),
      onAuthorizationSuccess: jest.fn(),
    };

    withAuthorizationHandling(adapter, {
      sapiomClient: mockSapiomClient,
      authorizedEndpoints: [
        {
          pathPattern: /^\/api\/admin\//,
          serviceName: "admin-api",
        },
      ],
      ...authCallbacks,
    });

    mockAxios.onGet("/api/admin/users").reply((config) => {
      if (config.headers?.["X-Sapiom-Transaction-Id"] === "tx_axios_auth") {
        return [200, { users: ["alice", "bob"] }];
      }
      return [403, { error: "Unauthorized" }];
    });

    mockTransactionAPI.create.mockResolvedValue({
      id: "tx_axios_auth",
      status: TransactionStatus.AUTHORIZED,
    } as any);

    const response = await axiosInstance.get("/api/admin/users");

    expect(response.data).toEqual({ users: ["alice", "bob"] });
    expect(authCallbacks.onAuthorizationSuccess).toHaveBeenCalledWith(
      "tx_axios_auth",
      "/api/admin/users",
    );

    mockAxios.restore();
  });

  it("should throw AuthorizationDeniedError for denied transactions", async () => {
    const axiosInstance = axios.create({ baseURL: "https://api.example.com" });
    const mockAxios = new MockAdapter(axiosInstance);
    const adapter = createAxiosAdapter(axiosInstance);

    withAuthorizationHandling(adapter, {
      sapiomClient: mockSapiomClient,
      authorizedEndpoints: [
        {
          pathPattern: /^\/api\/admin\//,
          serviceName: "admin-api",
        },
      ],
    });

    mockTransactionAPI.create.mockResolvedValue({
      id: "tx_denied",
      status: TransactionStatus.DENIED,
    } as any);

    await expect(axiosInstance.get("/api/admin/users")).rejects.toThrow(
      AuthorizationDeniedError,
    );

    mockAxios.restore();
  });
});
