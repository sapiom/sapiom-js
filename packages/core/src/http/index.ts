/**
 * HTTP Client Abstraction
 *
 * This module provides HTTP-agnostic interfaces and adapters for
 * integrating Sapiom payment and authorization handling with any HTTP library.
 */

// Core types
export type { HttpClientAdapter, HttpRequest, HttpResponse, HttpError } from './types';

// Adapters
export {
  AxiosAdapter,
  createAxiosAdapter,
  FetchAdapter,
  createFetchAdapter,
  NodeHttpAdapter,
  createNodeHttpAdapter,
} from './adapters';
