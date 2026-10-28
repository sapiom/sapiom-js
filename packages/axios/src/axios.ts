import { AxiosInstance, InternalAxiosRequestConfig } from "axios";

import {
  BaseSapiomIntegrationConfig,
  initializeSapiomClient,
} from "@sapiom/core";
import type { TransactionPollingConfig } from "@sapiom/core";
import {
  addAuthorizationInterceptor,
  addPaymentInterceptor,
  addCompletionInterceptor,
} from "./interceptors.js";

/**
 * Configuration for Sapiom-enabled Axios client
 */
export interface SapiomAxiosConfig extends BaseSapiomIntegrationConfig {
  /**
   * Polling configuration for transaction authorization.
   * Overrides default timeout (30s) and poll interval (1s).
   */
  polling?: TransactionPollingConfig;
}

/** follow-redirects strips only authorization, cookie and proxy-authorization on an
 * origin change, so the identity JWT needs its own guard. */
function dropIdentityOnCrossOriginRedirect(
  config: InternalAxiosRequestConfig,
  targetUrl: string,
): void {
  const origin = new URL(targetUrl).origin;
  const callerHook = config.beforeRedirect;
  config.beforeRedirect = (options, responseDetails, ...rest: unknown[]) => {
    const destination = () => {
      const path = (options as { path?: unknown }).path;
      // Through a forward proxy, `path` is the absolute URL the proxy requests.
      if (typeof path === "string" && /^[a-z][a-z\d+.-]*:\/\//i.test(path)) {
        return path;
      }
      // follow-redirects gives an IPv6 hostname without its brackets.
      const host = options.hostname?.includes(":")
        ? `[${options.hostname}]`
        : options.hostname;
      const port = options.port ? `:${options.port}` : "";
      return `${options.protocol}//${host}${port}${typeof path === "string" ? path : ""}`;
    };
    const before = destination();
    (callerHook as any)?.(options, responseDetails, ...rest);
    const after = destination();
    // Unchanged by the caller's hook, these options may name axios's proxy, so the
    // redirect target is read from `href`.
    const href = (options as { href?: unknown }).href;
    let hopOrigin: string | undefined;
    try {
      hopOrigin = new URL(
        after === before && typeof href === "string" ? href : after,
      ).origin;
    } catch {
      hopOrigin = undefined;
    }
    if (hopOrigin === origin) return;
    const headers = options.headers as Record<string, unknown> | undefined;
    if (!headers) return;
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "sapiom-identity") delete headers[name];
    }
  };
}

/**
 * Creates a Sapiom-enabled Axios client with automatic authorization and payment handling
 *
 * @param axiosInstance - The Axios instance to wrap with Sapiom handling
 * @param config - Optional configuration (reads from env vars by default)
 * @returns The same Axios instance (now Sapiom-enabled)
 *
 * @example
 * ```typescript
 * // Simplest usage (reads SAPIOM_API_KEY from environment)
 * import axios from 'axios';
 * import { withSapiom } from '@sapiom/axios';
 *
 * const client = withSapiom(axios.create({
 *   baseURL: 'https://api.example.com'
 * }));
 *
 * const data = await client.get('/premium-endpoint');
 * ```
 *
 * @example
 * ```typescript
 * // With API key and default metadata
 * import axios from 'axios';
 * import { withSapiom } from '@sapiom/axios';
 *
 * const client = withSapiom(axios.create({
 *   baseURL: 'https://api.example.com'
 * }), {
 *   apiKey: 'sk_...',
 *   agentName: 'my-agent',
 *   serviceName: 'my-service'
 * });
 *
 * // Per-request override via __sapiom
 * await client.post('/api/resource', data, {
 *   __sapiom: {
 *     serviceName: 'different-service',
 *     actionName: 'custom-action'
 *   }
 * });
 *
 * // Disable Sapiom for specific request
 * await client.get('/api/public', {
 *   __sapiom: { enabled: false }
 * });
 * ```
 */
export function withSapiom(
  axiosInstance: AxiosInstance,
  config?: SapiomAxiosConfig,
): AxiosInstance {
  if (config?.enabled === false) {
    return axiosInstance;
  }

  const sapiomClient = initializeSapiomClient(config);
  const failureMode = config?.failureMode ?? "open";

  const defaultMetadata: any = {};
  if (config?.agentName) defaultMetadata.agentName = config.agentName;
  if (config?.agentId) defaultMetadata.agentId = config.agentId;
  if (config?.serviceName) defaultMetadata.serviceName = config.serviceName;
  if (config?.traceId) defaultMetadata.traceId = config.traceId;
  if (config?.traceExternalId)
    defaultMetadata.traceExternalId = config.traceExternalId;
  if (config?.enabled !== undefined) defaultMetadata.enabled = config.enabled;

  if (Object.keys(defaultMetadata).length > 0) {
    (axiosInstance as any).__sapiomDefaultMetadata = defaultMetadata;
  }

  (axiosInstance as any).__sapiomFailureMode = failureMode;

  // Identity header interceptor: attach Sapiom-Identity when target matches token audience
  if (sapiomClient.identity) {
    axiosInstance.interceptors.request.use(async (config) => {
      const metadata = {
        ...(axiosInstance as any).__sapiomDefaultMetadata,
        ...(config as any).__sapiom,
      };
      if (metadata.enabled === false) return config;
      // Match the URL axios will request, so `baseURL` and `allowAbsoluteUrls` count.
      const url = config.url !== undefined ? axiosInstance.getUri(config) : undefined;
      if (url) {
        const identityHeaders =
          await sapiomClient.identity.getHeaderIfMatch(url);
        if (identityHeaders["Sapiom-Identity"]) {
          config.headers.set(
            "Sapiom-Identity",
            identityHeaders["Sapiom-Identity"],
          );
          dropIdentityOnCrossOriginRedirect(config, url);
        }
      }
      return config;
    });
  }

  addAuthorizationInterceptor(axiosInstance, { sapiomClient, failureMode, polling: config?.polling });
  // IMPORTANT: Completion interceptor must be added BEFORE payment interceptor
  // because Axios response interceptors run in LIFO order (last added runs first).
  // We want: request -> payment handling (retry on 402) -> completion
  addCompletionInterceptor(axiosInstance, { sapiomClient });
  addPaymentInterceptor(axiosInstance, { sapiomClient, failureMode, polling: config?.polling });

  (axiosInstance as any).__sapiomClient = sapiomClient;

  return axiosInstance;
}
