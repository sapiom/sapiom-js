/**
 * @sapiom/axios - Axios integration for Sapiom SDK
 *
 * Provides automatic payment handling and authorization for Axios HTTP clients
 * using native Axios interceptors.
 */

// Main entry point
export {
  createSapiomAxios,
  createSapiomAxios as createSapiomClient, // Backward compatibility alias
} from "./axios";
export type { SapiomAxiosConfig, BaseSapiomIntegrationConfig } from "./axios";

// Interceptor functions for manual setup
export {
  addAuthorizationInterceptor,
  addPaymentInterceptor,
  AuthorizationDeniedError,
  AuthorizationTimeoutError,
} from "./interceptors";

export type {
  AuthorizationInterceptorConfig,
  PaymentInterceptorConfig,
  EndpointAuthorizationRule,
} from "./interceptors";

// Type augmentations for axios
export {} from "./augmentations";

// Re-export commonly used types from core
export type {
  SapiomClient,
  SapiomClientConfig,
  TransactionResponse,
  PaymentTransactionResponse,
  TransactionStatus,
} from "@sapiom/core";
