/**
 * HTTP Client Integrations
 *
 * Simplified integration functions for popular HTTP clients.
 * These provide "magic" one-liner setup with automatic payment and authorization handling.
 */

export { createSapiomAxios } from './axios';
export type { SapiomAxiosConfig } from './axios';

export { createSapiomFetch } from './fetch';
export type { SapiomFetchConfig } from './fetch';

export { createSapiomNodeHttp } from './node-http';
export type { SapiomNodeHttpConfig } from './node-http';
