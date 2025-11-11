import {
  AuthorizationDeniedError,
  AuthorizationHandler,
  AuthorizationHandlerConfig,
  AuthorizationTimeoutError,
  EndpointAuthorizationRule,
  PaymentHandler,
  PaymentHandlerConfig,
  SapiomHandlerConfig,
  withAuthorizationHandling,
  withPaymentHandling,
  withSapiomHandling,
} from './index';

describe('@sapiom/sdk/core module', () => {
  describe('module exports', () => {
    it('should export PaymentHandler class', () => {
      expect(PaymentHandler).toBeDefined();
      expect(typeof PaymentHandler).toBe('function');
    });

    it('should export AuthorizationHandler class', () => {
      expect(AuthorizationHandler).toBeDefined();
      expect(typeof AuthorizationHandler).toBe('function');
    });

    it('should export AuthorizationDeniedError class', () => {
      expect(AuthorizationDeniedError).toBeDefined();
      expect(typeof AuthorizationDeniedError).toBe('function');
    });

    it('should export AuthorizationTimeoutError class', () => {
      expect(AuthorizationTimeoutError).toBeDefined();
      expect(typeof AuthorizationTimeoutError).toBe('function');
    });

    it('should export withPaymentHandling function', () => {
      expect(withPaymentHandling).toBeDefined();
      expect(typeof withPaymentHandling).toBe('function');
    });

    it('should export withAuthorizationHandling function', () => {
      expect(withAuthorizationHandling).toBeDefined();
      expect(typeof withAuthorizationHandling).toBe('function');
    });

    it('should export withSapiomHandling function', () => {
      expect(withSapiomHandling).toBeDefined();
      expect(typeof withSapiomHandling).toBe('function');
    });
  });

  describe('type exports', () => {
    it('should export PaymentHandlerConfig type', () => {
      // Type test - this will fail at compile time if type is not exported
      const config: PaymentHandlerConfig = {
        sapiomClient: {} as any,
      };
      expect(config).toBeDefined();
    });

    it('should export AuthorizationHandlerConfig type', () => {
      // Type test - this will fail at compile time if type is not exported
      const config: AuthorizationHandlerConfig = {
        sapiomClient: {} as any,
      };
      expect(config).toBeDefined();
    });

    it('should export EndpointAuthorizationRule type', () => {
      // Type test - this will fail at compile time if type is not exported
      const rule: EndpointAuthorizationRule = {
        pathPattern: /^\/admin/,
        serviceName: 'admin-api',
      };
      expect(rule).toBeDefined();
    });

    it('should export SapiomHandlerConfig type', () => {
      // Type test - this will fail at compile time if type is not exported
      const config: SapiomHandlerConfig = {
        sapiomClient: {} as any,
      };
      expect(config).toBeDefined();
    });
  });

  describe('error classes', () => {
    it('should create AuthorizationDeniedError instances', () => {
      const error = new AuthorizationDeniedError('tx-123', '/api/admin/users', 'Insufficient permissions');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AuthorizationDeniedError);
      expect(error.message).toContain('/api/admin/users');
      expect(error.message).toContain('Insufficient permissions');
      expect(error.transactionId).toBe('tx-123');
      expect(error.endpoint).toBe('/api/admin/users');
      expect(error.reason).toBe('Insufficient permissions');
    });

    it('should create AuthorizationTimeoutError instances', () => {
      const error = new AuthorizationTimeoutError('tx-456', '/api/premium/data', 5000);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AuthorizationTimeoutError);
      expect(error.message).toContain('/api/premium/data');
      expect(error.message).toContain('5000');
      expect(error.transactionId).toBe('tx-456');
      expect(error.endpoint).toBe('/api/premium/data');
      expect(error.timeout).toBe(5000);
    });
  });

  describe('integration for advanced users', () => {
    it('should provide all primitives needed for custom integration', () => {
      // Verify all necessary exports are available
      expect(PaymentHandler).toBeDefined();
      expect(AuthorizationHandler).toBeDefined();
      expect(withPaymentHandling).toBeDefined();
      expect(withAuthorizationHandling).toBeDefined();
      expect(withSapiomHandling).toBeDefined();
    });

    it('should support type-safe configuration', () => {
      // Type test - verify config types work together
      const sapiomConfig: SapiomHandlerConfig = {
        sapiomClient: {} as any,
        authorization: {
          authorizedEndpoints: [{ pathPattern: /^\/admin/, serviceName: 'admin' }],
        },
        payment: {
          onPaymentRequired: jest.fn(),
        },
      };

      expect(sapiomConfig).toBeDefined();
    });

    it('should allow payment-only configuration', () => {
      const paymentConfig: PaymentHandlerConfig = {
        sapiomClient: {} as any,
        onPaymentRequired: jest.fn(),
        onPaymentAuthorized: jest.fn(),
      };

      expect(paymentConfig).toBeDefined();
    });

    it('should allow authorization-only configuration', () => {
      const authConfig: AuthorizationHandlerConfig = {
        sapiomClient: {} as any,
        authorizedEndpoints: [{ pathPattern: /^\/admin/, serviceName: 'admin' }],
      };

      expect(authConfig).toBeDefined();
    });
  });

  describe('documentation examples', () => {
    it('should support the advanced usage pattern from README', () => {
      // This pattern should work as documented
      const mockAdapter: HttpClientAdapter = {
        request: jest.fn(),
        addRequestInterceptor: jest.fn(),
        addResponseInterceptor: jest.fn(),
      };

      const mockSapiomClient = {} as any;

      // Should not throw
      expect(() => {
        withSapiomHandling(mockAdapter, {
          sapiomClient: mockSapiomClient,
          authorization: { enabled: false },
          payment: { enabled: false },
        });
      }).not.toThrow();
    });

    it('should support payment-only handler pattern from README', () => {
      const mockAdapter: HttpClientAdapter = {
        request: jest.fn(),
        addRequestInterceptor: jest.fn(),
        addResponseInterceptor: jest.fn(),
      };

      const mockSapiomClient = {} as any;

      // Should not throw
      expect(() => {
        withPaymentHandling(mockAdapter, {
          sapiomClient: mockSapiomClient,
        });
      }).not.toThrow();
    });

    it('should support authorization-only handler pattern from README', () => {
      const mockAdapter: HttpClientAdapter = {
        request: jest.fn(),
        addRequestInterceptor: jest.fn(),
        addResponseInterceptor: jest.fn(),
      };

      const mockSapiomClient = {} as any;

      // Should not throw
      expect(() => {
        withAuthorizationHandling(mockAdapter, {
          sapiomClient: mockSapiomClient,
          authorizedEndpoints: [{ pathPattern: /^\/admin/, serviceName: 'admin' }],
        });
      }).not.toThrow();
    });
  });
});
