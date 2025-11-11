// Main client
export { SapiomClient } from './lib/SapiomClient';
export type { SapiomClientConfig } from './lib/SapiomClient';
export { TransactionAPI } from './lib/TransactionAPI';

// HTTP Client Abstraction
export type { HttpClientAdapter, HttpRequest, HttpResponse, HttpError, SapiomTransactionMetadata } from './http/types';

// HTTP Adapters
export {
  AxiosAdapter,
  createAxiosAdapter,
  FetchAdapter,
  createFetchAdapter,
  NodeHttpAdapter,
  createNodeHttpAdapter,
} from './http/adapters';

// Payment Error Detection
export {
  PaymentRequiredError,
  isPaymentRequiredError,
  isAxios402Error,
  isHttp402Error,
  extractPaymentData,
  extractResourceFromError,
  extractTransactionId,
  convertX402ToPaymentData,
  wrapWith402Detection,
  registerErrorDetector,
  AxiosErrorDetector,
  HttpErrorDetector,
} from './lib/PaymentErrorDetection';

export type {
  X402PaymentResponse,
  X402PaymentRequirement,
  SapiomPaymentResponse,
  ExtractedPaymentInfo,
  ErrorDetectorAdapter,
} from './lib/PaymentErrorDetection';

// Core Handlers
export { PaymentHandler } from './core/PaymentHandler';
export type { PaymentHandlerConfig } from './core/PaymentHandler';

export { AuthorizationHandler, AuthorizationDeniedError, AuthorizationTimeoutError } from './core/AuthorizationHandler';
export type { AuthorizationHandlerConfig, EndpointAuthorizationRule } from './core/AuthorizationHandler';

// Wrapper Functions
export { withPaymentHandling, withAuthorizationHandling } from './core/wrappers';
export { withSapiomHandling } from './core/SapiomHandler';
export type { SapiomHandlerConfig } from './core/SapiomHandler';

// Types
export { TransactionStatus } from './types/transaction';

export type {
  PaymentData,
  CreateTransactionRequest,
  TransactionResponse,
  PaymentTransactionResponse,
  ListTransactionsParams,
  ReauthorizeWithPaymentRequest,
} from './types/transaction';

// Simple Integration Functions (Recommended for most users)
export { createSapiomAxios } from './integrations/http/axios';
export type { SapiomAxiosConfig } from './integrations/http/axios';

export { createSapiomFetch } from './integrations/http/fetch';
export type { SapiomFetchConfig } from './integrations/http/fetch';

export { createSapiomNodeHttp } from './integrations/http/node-http';
export type { SapiomNodeHttpConfig } from './integrations/http/node-http';

// Shared integration utilities
export { initializeSapiomClient } from './integrations/shared';
export type { BaseSapiomIntegrationConfig } from './integrations/shared';

// Default export for convenience
export { SapiomClient as default } from './lib/SapiomClient';
