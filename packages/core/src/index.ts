/**
 * @sapiom/core - Core SDK for Sapiom API
 *
 * Provides the foundational client and utilities for interacting with Sapiom,
 * including transaction management, authorization, and payment handling.
 *
 * @packageDocumentation
 */

// Main client
export { SapiomClient } from "./client/SapiomClient.js";
export type { SapiomClientConfig } from "./client/SapiomClient.js";
export { TransactionAPI } from "./client/TransactionAPI.js";

// Payment Error Detection
export {
  PaymentRequiredError,
  isPaymentRequiredError,
  isAxios402Error,
  isHttp402Error,
  extractResourceFromError,
  extractTransactionId,
  extractX402Response,
  wrapWith402Detection,
  registerErrorDetector,
  AxiosErrorDetector,
  HttpErrorDetector,
} from "./errors/PaymentErrorDetection.js";

export type {
  X402PaymentResponse,
  X402PaymentRequirement as X402PaymentRequirementFromError,
  SapiomPaymentResponse,
  ErrorDetectorAdapter,
} from "./errors/PaymentErrorDetection.js";

// Transaction Authorizer
export { TransactionAuthorizer } from "./utils/TransactionAuthorizer.js";
export type { TransactionAuthorizerConfig } from "./utils/TransactionAuthorizer.js";

// Transaction Polling
export { TransactionPoller } from "./client/TransactionPoller.js";
export type {
  TransactionPollingConfig,
  TransactionPollResult,
} from "./client/TransactionPoller.js";

// Telemetry
export { captureUserCallSite, getRuntimeInfo } from "./utils/telemetry.js";
export type { CallSiteInfo, RuntimeInfo } from "./types/telemetry.js";

// Types
export {
  TransactionStatus,
  TransactionOutcome,
  // x402 type guards
  isV1Response,
  isV2Response,
  isV1Requirement,
  isV2Requirement,
  // x402 helpers
  getPaymentAmount,
  getResourceUrl,
  getX402Version,
} from "./types/transaction.js";

export type {
  CompleteTransactionRequest,
  CompleteTransactionResult,
  CreateTransactionRequest,
  TransactionResponse,
  PaymentTransactionResponse,
  ListTransactionsParams,
  PaymentProtocolData,
  // x402 union types (backward compatible)
  X402Response,
  X402PaymentRequirement,
  // x402 versioned types
  X402PaymentRequirementV1,
  X402PaymentRequirementV2,
  X402ResponseV1,
  X402ResponseV2,
} from "./types/transaction.js";

// HTTP Types (needed by HTTP integration packages)
export type {
  HttpClientAdapter,
  HttpRequest,
  HttpResponse,
  HttpError,
  SapiomTransactionMetadata,
} from "./types/http.js";

// HTTP Schemas (versioned fact schemas)
export type {
  HttpClientFacts,
  HttpClientRequestFacts,
  HttpClientResponseFacts,
  HttpClientErrorFacts,
} from "./schemas/http-client-v1.js";

// Shared integration utilities (needed by HTTP integration packages)
export { initializeSapiomClient } from "./types/config.js";
export type { BaseSapiomIntegrationConfig, FailureMode } from "./types/config.js";

// Default export for convenience
export { SapiomClient as default } from "./client/SapiomClient.js";
