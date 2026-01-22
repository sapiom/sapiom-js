/**
 * @sapiom/node-http - Node.js HTTP client integration for Sapiom SDK
 *
 * Provides a native Node.js HTTP client with automatic authorization
 * and payment handling using the http/https modules.
 *
 * @packageDocumentation
 */

export {
  createClient,
  AuthorizationDeniedError,
  AuthorizationTimeoutError,
} from "./node-http.js";
export type { SapiomNodeHttpConfig } from "./node-http.js";
