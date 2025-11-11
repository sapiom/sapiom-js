import { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import { HttpClientAdapter, HttpError, HttpRequest, HttpResponse } from '../types';

/**
 * Axios adapter for HTTP client abstraction
 * Wraps an Axios instance to provide the HttpClientAdapter interface
 */
export class AxiosAdapter implements HttpClientAdapter {
  constructor(private axiosInstance: AxiosInstance) {}

  async request<T = any>(request: HttpRequest): Promise<HttpResponse<T>> {
    const response = await this.axiosInstance.request({
      method: request.method,
      url: request.url,
      headers: request.headers,
      data: request.body,
      params: request.params,
      // Pass through __sapiom for user metadata
      ...(request.__sapiom && { __sapiom: request.__sapiom }),
      // Store internal metadata in __sapiomInternal to avoid conflicts
      ...(request.metadata && { __sapiomInternal: request.metadata }),
    } as InternalAxiosRequestConfig);

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers as Record<string, string>,
      data: response.data,
    };
  }

  addRequestInterceptor(
    onFulfilled: (request: HttpRequest) => HttpRequest | Promise<HttpRequest>,
    onRejected?: (error: any) => any,
  ): () => void {
    const id = this.axiosInstance.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      // Convert Axios config to generic HttpRequest
      const genericRequest: HttpRequest = {
        method: config.method || 'GET',
        url: config.url || '',
        headers: config.headers as Record<string, string>,
        body: config.data,
        params: config.params,
        __sapiom: (config as any).__sapiom,
        metadata: (config as any).__sapiomInternal,
      };

      // Call the interceptor
      const result = await onFulfilled(genericRequest);

      // Convert back to Axios config
      const updatedConfig: InternalAxiosRequestConfig = {
        ...config,
        method: result.method,
        url: result.url,
        headers: result.headers as any,
        data: result.body,
        params: result.params,
      };

      // Store both user metadata and internal metadata
      if (result.__sapiom) {
        (updatedConfig as any).__sapiom = result.__sapiom;
      }
      if (result.metadata) {
        (updatedConfig as any).__sapiomInternal = result.metadata;
      }

      return updatedConfig;
    }, onRejected);

    return () => this.axiosInstance.interceptors.request.eject(id);
  }

  addResponseInterceptor(
    onFulfilled: (response: HttpResponse) => HttpResponse | Promise<HttpResponse>,
    onRejected?: (error: HttpError) => any,
  ): () => void {
    const id = this.axiosInstance.interceptors.response.use(
      async (response: AxiosResponse) => {
        // Convert Axios response to generic HttpResponse
        const genericResponse: HttpResponse = {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers as Record<string, string>,
          data: response.data,
        };

        // Call the interceptor
        const result = await onFulfilled(genericResponse);

        // Convert back to Axios response
        return {
          ...response,
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
          data: result.data,
        };
      },
      async (error: AxiosError) => {
        // Convert Axios error to generic HttpError
        // Note: Axios may have already JSON.stringified the body, so parse it back if needed
        let requestBody = error.config?.data;
        if (typeof requestBody === 'string' && requestBody.startsWith('{')) {
          try {
            requestBody = JSON.parse(requestBody);
          } catch {
            // Keep as string if parsing fails
          }
        }

        const genericError: HttpError = {
          message: error.message,
          status: error.response?.status,
          statusText: error.response?.statusText,
          headers: error.response?.headers as Record<string, string>,
          data: error.response?.data,
          request: error.config
            ? {
                method: error.config.method || 'GET',
                url: error.config.url || '',
                headers: error.config.headers as Record<string, string>,
                body: requestBody,
                params: error.config.params,
                __sapiom: (error.config as any).__sapiom,
                metadata: (error.config as any).__sapiomInternal,
              }
            : undefined,
          response: error.response
            ? {
                status: error.response.status,
                statusText: error.response.statusText,
                headers: error.response.headers as Record<string, string>,
                data: error.response.data,
              }
            : undefined,
        };

        // Call the error handler if provided
        if (onRejected) {
          return await onRejected(genericError);
        }

        // Re-throw the error
        return Promise.reject(genericError);
      },
    );

    return () => this.axiosInstance.interceptors.response.eject(id);
  }
}

/**
 * Convenience function to create an Axios adapter
 * @param axiosInstance The Axios instance to wrap
 * @returns HttpClientAdapter wrapping the Axios instance
 *
 * @example
 * ```typescript
 * import axios from 'axios';
 * import { createAxiosAdapter } from '@sapiom/sdk';
 *
 * const axiosInstance = axios.create({ baseURL: 'https://api.example.com' });
 * const adapter = createAxiosAdapter(axiosInstance);
 * ```
 */
export function createAxiosAdapter(axiosInstance: AxiosInstance): HttpClientAdapter {
  return new AxiosAdapter(axiosInstance);
}
