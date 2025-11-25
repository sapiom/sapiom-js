// Main client
export { SapiomClient } from "./client/SapiomClient";
export type { SapiomClientConfig } from "./client/SapiomClient";
export { TransactionAPI } from "./client/TransactionAPI";

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
} from "./errors/PaymentErrorDetection";

export type {
  X402PaymentResponse,
  X402PaymentRequirement as X402PaymentRequirementFromError,
  SapiomPaymentResponse,
  ErrorDetectorAdapter,
} from "./errors/PaymentErrorDetection";

// Transaction Authorizer
export { TransactionAuthorizer } from "./utils/TransactionAuthorizer";
export type { TransactionAuthorizerConfig } from "./utils/TransactionAuthorizer";

// Transaction Polling
export { TransactionPoller } from "./client/TransactionPoller";
export type {
  TransactionPollingConfig,
  TransactionPollResult,
} from "./client/TransactionPoller";

// Telemetry
export { captureUserCallSite, getRuntimeInfo } from "./utils/telemetry";
export type { CallSiteInfo, RuntimeInfo } from "./types/telemetry";

// Types
export { TransactionStatus } from "./types/transaction";

export type {
  CreateTransactionRequest,
  TransactionResponse,
  PaymentTransactionResponse,
  ListTransactionsParams,
  PaymentProtocolData,
  X402Response,
  X402PaymentRequirement,
} from "./types/transaction";

// HTTP Types (needed by HTTP integration packages)
export type {
  HttpClientAdapter,
  HttpRequest,
  HttpResponse,
  HttpError,
  SapiomTransactionMetadata,
} from "./types/http";

// HTTP Schemas (versioned fact schemas)
export type {
  HttpClientFacts,
  HttpClientRequestFacts,
  HttpClientResponseFacts,
  HttpClientErrorFacts,
} from "./schemas/http-client-v1";

// Shared integration utilities (needed by HTTP integration packages)
export { initializeSapiomClient } from "./types/config";
export type { BaseSapiomIntegrationConfig, FailureMode } from "./types/config";

// Default export for convenience
export { SapiomClient as default } from "./client/SapiomClient";
