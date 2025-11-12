/**
 * @sapiom/fetch - Fetch API integration for Sapiom SDK
 *
 * Provides automatic payment handling and authorization for native fetch.
 */

export {
  createSapiomFetch,
  createSapiomFetch as createSapiomClient,
} from "./fetch";
export type { SapiomFetchConfig } from "./fetch";

// Re-export adapter and types for advanced use cases
export { createFetchAdapter, FetchAdapter } from "./adapter";
export type {
  HttpClientAdapter,
  HttpRequest,
  HttpResponse,
  HttpError,
} from "@sapiom/core";
