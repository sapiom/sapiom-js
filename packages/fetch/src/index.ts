/**
 * @sapiom/fetch - Fetch API integration for Sapiom SDK
 *
 * Provides a drop-in replacement for native fetch() with automatic
 * authorization and payment handling.
 *
 * @packageDocumentation
 */

export {
  createFetch,
  AuthorizationDeniedError,
  AuthorizationTimeoutError,
} from "./fetch.js";
export type { SapiomFetchConfig } from "./fetch.js";
