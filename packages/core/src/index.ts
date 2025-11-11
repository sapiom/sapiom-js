// Main client
export { SapiomClient } from './lib/SapiomClient';
export type { SapiomClientConfig } from './lib/SapiomClient';
export { TransactionAPI } from './lib/TransactionAPI';

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

// Transaction Authorizer
export { TransactionAuthorizer } from './core/TransactionAuthorizer';
export type { TransactionAuthorizerConfig } from './core/TransactionAuthorizer';

// Telemetry
export { captureUserCallSite, getRuntimeInfo } from './lib/telemetry';
export type { CallSiteInfo, RuntimeInfo } from './types/telemetry';

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

// HTTP Types (needed by HTTP integration packages)
export type { HttpClientAdapter, HttpRequest, HttpResponse, HttpError, SapiomTransactionMetadata } from './http/types';

// Shared integration utilities (needed by HTTP integration packages)
export { initializeSapiomClient } from './integrations/shared';
export type { BaseSapiomIntegrationConfig } from './integrations/shared';

// Default export for convenience
export { SapiomClient as default } from './lib/SapiomClient';
