/**
 * Integration tests for unified SapiomHandler with Node HTTP adapter
 * Tests combined authorization + payment flow (Node HTTP-specific tests only)
 */
import { createNodeHttpAdapter } from './adapter';
import { SapiomClient } from '@sapiom/core';
import { TransactionAPI } from '@sapiom/core';
import { TransactionStatus } from '@sapiom/core';
import { withSapiomHandling } from '@sapiom/core';

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

  // Note: The SapiomHandler integration test file in the monorepo source
  // only contained Axios-based tests in its main test cases.
  // Fetch and Node HTTP specific integration tests would be added here
  // if they existed in the original source file.
  // For now, this file serves as a placeholder for future Node HTTP-specific
  // unified handler tests.

  it('should be able to create node-http adapter with Sapiom handling', () => {
    const adapter = createNodeHttpAdapter();

    withSapiomHandling(adapter, {
      sapiomClient: mockSapiomClient,
    });

    expect(adapter).toBeDefined();
  });
});
