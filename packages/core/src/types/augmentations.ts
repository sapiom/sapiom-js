/**
 * Type augmentations for Sapiom-enabled HTTP clients
 *
 * These augmentations add the __sapiomClient property to wrapped instances
 * for better TypeScript support when accessing the underlying SapiomClient.
 */
import { AxiosInstance } from 'axios';

import { SapiomClient } from '../lib/SapiomClient';

declare module 'axios' {
  interface AxiosInstance {
    /**
     * Reference to the SapiomClient used for payment and authorization handling
     * Available when axios instance is wrapped with createSapiomClient from @sapiom/sdk/axios
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
    __sapiomClient?: SapiomClient;
  }
}
