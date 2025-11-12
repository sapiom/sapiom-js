/**
 * @sapiom/node-http - Node.js HTTP/HTTPS integration for Sapiom SDK
 * 
 * Provides automatic payment handling and authorization for Node.js http/https modules.
 */

export { createSapiomNodeHttp, createSapiomNodeHttp as createSapiomClient } from './node-http';
export type { SapiomNodeHttpConfig } from './node-http';

// Re-export adapter and types for advanced use cases
export { createNodeHttpAdapter, NodeHttpAdapter } from './adapter';
export type { HttpClientAdapter, HttpRequest, HttpResponse, HttpError } from '@sapiom/core';
