/**
 * @sapiom/axios - Axios integration for Sapiom SDK
 *
 * Provides automatic payment handling and authorization for Axios HTTP clients
 * using native Axios interceptors.
 */

export { withSapiom } from "./axios.js";
export type { SapiomAxiosConfig } from "./axios.js";

export {
  AuthorizationDeniedError,
  AuthorizationTimeoutError,
} from "./interceptors.js";

// Type augmentations for axios
export {} from "./augmentations.js";

// Re-export commonly used types from core
export type {
  SapiomClient,
  SapiomClientConfig,
  BaseSapiomIntegrationConfig,
  TransactionResponse,
  PaymentTransactionResponse,
  TransactionStatus,
} from "@sapiom/core";
