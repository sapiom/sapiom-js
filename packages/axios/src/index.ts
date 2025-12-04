/**
 * @sapiom/axios - Axios integration for Sapiom SDK
 *
 * Provides automatic payment handling and authorization for Axios HTTP clients
 * using native Axios interceptors.
 */

export { withSapiom } from "./axios";
export type { SapiomAxiosConfig } from "./axios";

export {
  AuthorizationDeniedError,
  AuthorizationTimeoutError,
} from "./interceptors";

// Type augmentations for axios
export {} from "./augmentations";

// Re-export commonly used types from core
export type {
  SapiomClient,
  SapiomClientConfig,
  BaseSapiomIntegrationConfig,
  TransactionResponse,
  PaymentTransactionResponse,
  TransactionStatus,
} from "@sapiom/core";
