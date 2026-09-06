import { createFetch } from "./fetch";
import { SapiomClient, TransactionAPI } from "@sapiom/core";

describe("createFetch", () => {
  let mockSapiomClient: SapiomClient;

  beforeEach(() => {
    const mockTransactionAPI: jest.Mocked<TransactionAPI> = {
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

  it("should create a fetch function", () => {
    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
    });

    expect(typeof fetch).toBe("function");
  });

  it("should attach sapiomClient to fetch function", () => {
    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
    });

    expect((fetch as any).__sapiomClient).toBe(mockSapiomClient);
  });

  it("should create fetch with default metadata", () => {
    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      agentName: "test-agent",
      agentId: "agent-123",
      serviceName: "test-service",
    });

    expect(typeof fetch).toBe("function");
  });

  it("should honor __sapiom = { enabled: false } on a Request input, surviving the internal clone", async () => {
    // sapiomFetch internally does `new Request(input, init)` before reading
    // __sapiom. Native Request cloning drops custom properties, so this
    // regression-tests that the metadata set on the *original* Request is
    // still honored after that clone (issue #690).
    const globalFetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));

    const fetch = createFetch({ sapiomClient: mockSapiomClient });

    const request = new Request("https://example.test/public");
    (request as any).__sapiom = { enabled: false };

    await fetch(request as any);

    // The enabled:false bypass calls globalThis.fetch directly, skipping
    // authorization entirely. If __sapiom were lost, this would instead
    // fall through into the (unmocked) authorization path.
    expect(globalFetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSapiomClient.transactions.create).not.toHaveBeenCalled();

    globalFetchSpy.mockRestore();
  });
});
