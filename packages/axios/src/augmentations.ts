/**
 * Type augmentations for Sapiom-enabled HTTP clients
 *
 * These augmentations add the __sapiomClient property to wrapped instances
 * for better TypeScript support when accessing the underlying SapiomClient.
 */
import { AxiosInstance } from "axios";

import { SapiomClient } from "@sapiom/core";

declare module "axios" {
  interface AxiosInstance {
    /**
     * Reference to the SapiomClient used for payment and authorization handling
     * Available when axios instance is wrapped with withSapiom from @sapiom/axios
     *
     * @example
     * ```typescript
     * import axios from 'axios';
     * import { withSapiom } from '@sapiom/axios';
     *
     * const client = withSapiom(axios.create({
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
