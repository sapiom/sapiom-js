/**
 * Type augmentations for Sapiom-enabled HTTP clients
 *
 * These augmentations add the __sapiomClient property to wrapped instances
 * for better TypeScript support when accessing the underlying SapiomClient.
 */
import { AxiosInstance } from "axios";

import { SapiomClient } from "@sapiom/core";

/**
 * Per-request Sapiom configuration passed via `__sapiom` on axios request config
 */
export interface SapiomRequestConfig {
  enabled?: boolean;
  serviceName?: string;
  actionName?: string;
  resourceName?: string;
  traceId?: string;
  traceExternalId?: string;
  agentId?: string;
  agentName?: string;
  qualifiers?: Record<string, string>;
  metadata?: Record<string, any>;

  /**
   * Factory function that returns a fresh request body on each call.
   * Use this when streaming a body (e.g. `fs.createReadStream(...)`) so that
   * a 402 retry can re-create the stream instead of sending a consumed one.
   *
   * @example
   * ```typescript
   * await client.post('/upload', fs.createReadStream('file.tar'), {
   *   __sapiom: {
   *     bodyFactory: () => fs.createReadStream('file.tar'),
   *   },
   * });
   * ```
   */
  bodyFactory?: () => any;
}

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
