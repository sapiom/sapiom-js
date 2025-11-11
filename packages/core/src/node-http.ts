/**
 * Node.js HTTP/HTTPS Integration for Sapiom SDK
 *
 * Import from '@sapiom/sdk/node-http' for Node.js native HTTP/HTTPS Sapiom integration.
 *
 * @example
 * ```typescript
 * import { createSapiomClient } from '@sapiom/sdk/node-http';
 *
 * const client = createSapiomClient();
 * const response = await client.request({
 *   method: 'GET',
 *   url: 'https://api.example.com/endpoint',
 *   headers: {}
 * });
 * ```
 */

export { createSapiomNodeHttp as createSapiomClient } from './integrations/http/node-http';
export type { SapiomNodeHttpConfig as SapiomClientConfig } from './integrations/http/node-http';

// Also export the original name for flexibility
export { createSapiomNodeHttp } from './integrations/http/node-http';
export type { SapiomNodeHttpConfig } from './integrations/http/node-http';
