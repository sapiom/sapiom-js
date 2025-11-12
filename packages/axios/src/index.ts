/**
 * @sapiom/axios - Axios integration for Sapiom SDK
 *
 * Provides automatic payment handling and authorization for Axios HTTP clients.
 */

export {
  createSapiomAxios,
  createSapiomAxios as createSapiomClient,
} from "./axios";
export type { SapiomAxiosConfig } from "./axios";

// Re-export adapter and types for advanced use cases
export { createAxiosAdapter, AxiosAdapter } from "./adapter";
export type {
  HttpClientAdapter,
  HttpRequest,
  HttpResponse,
  HttpError,
} from "@sapiom/core";
