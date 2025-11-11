/**
 * Axios Integration for Sapiom SDK
 *
 * Import from '@sapiom/sdk/axios' for Axios-specific Sapiom integration.
 *
 * @example
 * ```typescript
 * import axios from 'axios';
 * import { createSapiomClient } from '@sapiom/sdk/axios';
 *
 * const client = createSapiomClient(axios.create({
 *   baseURL: 'https://api.example.com'
 * }));
 *
 * // Access the underlying Sapiom client
 * const sapiomClient = client.__sapiomClient;
 * ```
 */
// Import type augmentations for __sapiomClient
import './types/augmentations';

export { createSapiomAxios as createSapiomClient } from './integrations/http/axios';
export type { SapiomAxiosConfig as SapiomClientConfig } from './integrations/http/axios';

// Also export the original name for flexibility
export { createSapiomAxios } from './integrations/http/axios';
export type { SapiomAxiosConfig } from './integrations/http/axios';
