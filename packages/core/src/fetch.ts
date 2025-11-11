/**
 * Fetch Integration for Sapiom SDK
 *
 * Import from '@sapiom/sdk/fetch' for Fetch API-specific Sapiom integration.
 * Drop-in replacement for native fetch with Sapiom payment and authorization handling.
 *
 * @example
 * ```typescript
 * import { createSapiomClient } from '@sapiom/sdk/fetch';
 *
 * // Works exactly like native fetch!
 * const fetch = createSapiomClient();
 * const response = await fetch('https://api.example.com/endpoint');
 * const data = await response.json();
 * ```
 */

export { createSapiomFetch as createSapiomClient } from './integrations/http/fetch';
export type { SapiomFetchConfig as SapiomClientConfig } from './integrations/http/fetch';

// Also export the original name for flexibility
export { createSapiomFetch } from './integrations/http/fetch';
export type { SapiomFetchConfig } from './integrations/http/fetch';
