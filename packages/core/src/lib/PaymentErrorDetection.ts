import { AxiosError } from 'axios';

import { HttpError } from '../http/types';
import { PaymentData } from '../types/transaction';

/**
 * Standard x402 protocol response format
 */
export interface X402PaymentResponse {
  x402Version: number;
  accepts: X402PaymentRequirement[];
}

export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
}

/**
 * Sapiom-specific payment response format
 * Wraps x402 protocol data
 */
export interface SapiomPaymentResponse {
  requiresPayment: true;
  transactionId?: string;
  paymentData: PaymentData;
  message?: string;
}

/**
 * Extracted payment information from an error
 */
export interface ExtractedPaymentInfo {
  paymentData: PaymentData;
  resource: string;
  transactionId?: string;
}

/**
 * Error detector adapter interface
 * Allows adding support for new HTTP libraries
 */
export interface ErrorDetectorAdapter {
  /**
   * Check if this adapter can handle the error
   */
  canHandle(error: unknown): boolean;

  /**
   * Check if error is a 402 payment error
   */
  is402Error(error: unknown): boolean;

  /**
   * Extract payment information from error
   */
  extractPaymentInfo(error: unknown): ExtractedPaymentInfo;
}

/**
 * Generic payment error that works across different error formats
 */
export class PaymentRequiredError extends Error {
  public readonly statusCode = 402;
  public readonly paymentData: PaymentData;
  public readonly resource: string;
  public readonly originalError?: Error;
  public readonly transactionId?: string;

  constructor(
    message: string,
    paymentData: PaymentData,
    resource: string,
    transactionId?: string,
    originalError?: Error,
  ) {
    super(message);
    this.name = 'PaymentRequiredError';
    this.paymentData = paymentData;
    this.resource = resource;
    this.transactionId = transactionId;
    this.originalError = originalError;

    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PaymentRequiredError);
    }
  }
}

/**
 * Axios error detector adapter
 */
export class AxiosErrorDetector implements ErrorDetectorAdapter {
  canHandle(error: unknown): boolean {
    return error instanceof Error && 'isAxiosError' in error;
  }

  is402Error(error: unknown): boolean {
    if (!this.canHandle(error)) return false;
    const axiosError = error as AxiosError;
    return axiosError.response?.status === 402;
  }

  extractPaymentInfo(error: unknown): ExtractedPaymentInfo {
    if (!this.canHandle(error)) {
      throw new Error('AxiosErrorDetector cannot handle this error');
    }

    const axiosError = error as AxiosError;
    const response = axiosError.response!;

    // Try x402 protocol format first
    if (isX402Response(response.data)) {
      const paymentData = convertX402ToPaymentData(response.data, axiosError.config?.url || '');
      const resource = response.data.accepts[0]?.resource || axiosError.config?.url || 'unknown';
      const transactionId = this.extractTransactionId(axiosError);

      return { paymentData, resource, transactionId };
    }

    // Try Sapiom format
    if (isSapiomPaymentResponse(response.data)) {
      return {
        paymentData: response.data.paymentData,
        resource: axiosError.config?.url || 'unknown',
        transactionId: response.data.transactionId,
      };
    }

    // Try header-based
    if (response.headers['x-payment-required']) {
      try {
        const headerData = JSON.parse(response.headers['x-payment-required']);
        return {
          paymentData: normalizeToPaymentData(headerData),
          resource: axiosError.config?.url || 'unknown',
          transactionId: this.extractTransactionId(axiosError),
        };
      } catch {
        // Fall through
      }
    }

    // Generic extraction
    return {
      paymentData: normalizeToPaymentData(response.data),
      resource: axiosError.config?.url || 'unknown',
      transactionId: this.extractTransactionId(axiosError),
    };
  }

  private extractTransactionId(error: AxiosError): string | undefined {
    const data = error.response?.data;

    if (isSapiomPaymentResponse(data)) {
      return data.transactionId;
    }

    if (error.response?.headers['x-sapiom-transaction-id']) {
      return error.response.headers['x-sapiom-transaction-id'];
    }

    if (data && typeof data === 'object') {
      return (data as any).transactionId || (data as any).transaction_id;
    }

    return undefined;
  }
}

/**
 * HttpError detector adapter
 */
export class HttpErrorDetector implements ErrorDetectorAdapter {
  canHandle(error: unknown): boolean {
    // Don't handle Axios errors - let AxiosErrorDetector handle those
    if (error instanceof Error && 'isAxiosError' in error) {
      return false;
    }
    return error !== null && typeof error === 'object' && 'status' in error && 'message' in error;
  }

  is402Error(error: unknown): boolean {
    if (!this.canHandle(error)) return false;
    const httpError = error as HttpError;
    return httpError.status === 402;
  }

  extractPaymentInfo(error: unknown): ExtractedPaymentInfo {
    if (!this.canHandle(error)) {
      throw new Error('HttpErrorDetector cannot handle this error');
    }

    const httpError = error as HttpError;

    // Try x402 protocol format first
    if (isX402Response(httpError.data)) {
      const paymentData = convertX402ToPaymentData(httpError.data, httpError.request?.url || '');
      const resource = httpError.data.accepts[0]?.resource || httpError.request?.url || 'unknown';
      const transactionId = this.extractTransactionId(httpError);

      return { paymentData, resource, transactionId };
    }

    // Try Sapiom format
    if (isSapiomPaymentResponse(httpError.data)) {
      return {
        paymentData: httpError.data.paymentData,
        resource: httpError.request?.url || 'unknown',
        transactionId: httpError.data.transactionId,
      };
    }

    // Try header-based
    if (httpError.headers?.['x-payment-required']) {
      try {
        const headerData = JSON.parse(httpError.headers['x-payment-required']);
        return {
          paymentData: normalizeToPaymentData(headerData),
          resource: httpError.request?.url || 'unknown',
          transactionId: this.extractTransactionId(httpError),
        };
      } catch {
        // Fall through
      }
    }

    // Generic extraction
    return {
      paymentData: normalizeToPaymentData(httpError.data),
      resource: httpError.request?.url || 'unknown',
      transactionId: this.extractTransactionId(httpError),
    };
  }

  private extractTransactionId(error: HttpError): string | undefined {
    const data = error.data;

    if (isSapiomPaymentResponse(data)) {
      return data.transactionId;
    }

    if (error.headers?.['x-sapiom-transaction-id']) {
      return error.headers['x-sapiom-transaction-id'];
    }

    if (data && typeof data === 'object') {
      return (data as any).transactionId || (data as any).transaction_id;
    }

    return undefined;
  }
}

/**
 * Registry for error detector adapters
 */
class ErrorDetectorRegistry {
  private detectors: ErrorDetectorAdapter[] = [];

  constructor() {
    // Register built-in detectors (order matters - more specific first)
    this.register(new HttpErrorDetector()); // Will be checked last due to unshift
    this.register(new AxiosErrorDetector()); // Will be checked first due to unshift
  }

  /**
   * Register a custom error detector adapter
   */
  register(detector: ErrorDetectorAdapter): void {
    this.detectors.unshift(detector); // Add to front for priority
  }

  /**
   * Find detector that can handle the error
   */
  findDetector(error: unknown): ErrorDetectorAdapter | undefined {
    return this.detectors.find((detector) => detector.canHandle(error));
  }

  /**
   * Check if error is a 402 payment error
   */
  is402Error(error: unknown): boolean {
    // First check PaymentRequiredError
    if (error instanceof PaymentRequiredError) {
      return true;
    }

    // Try detectors
    const detector = this.findDetector(error);
    if (detector) {
      return detector.is402Error(error);
    }

    // Fallback: check for payment-related messages
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('payment required') ||
        message.includes('402') ||
        ('statusCode' in error && (error as any).statusCode === 402)
      );
    }

    return false;
  }

  /**
   * Extract payment information from error
   */
  extractPaymentInfo(error: unknown): ExtractedPaymentInfo {
    // First check PaymentRequiredError
    if (error instanceof PaymentRequiredError) {
      return {
        paymentData: error.paymentData,
        resource: error.resource,
        transactionId: error.transactionId,
      };
    }

    // Try detectors
    const detector = this.findDetector(error);
    if (detector && detector.is402Error(error)) {
      return detector.extractPaymentInfo(error);
    }

    throw new Error('Unable to extract payment data from error');
  }
}

// Global registry instance
const globalRegistry = new ErrorDetectorRegistry();

/**
 * Register a custom error detector adapter
 *
 * @example
 * ```typescript
 * class GotErrorDetector implements ErrorDetectorAdapter {
 *   canHandle(error: unknown): boolean {
 *     return error instanceof Error && 'name' in error && error.name === 'HTTPError';
 *   }
 *
 *   is402Error(error: unknown): boolean {
 *     if (!this.canHandle(error)) return false;
 *     return (error as any).response?.statusCode === 402;
 *   }
 *
 *   extractPaymentInfo(error: unknown): ExtractedPaymentInfo {
 *     const gotError = error as any;
 *     // Extract from got-specific error structure
 *     return { ... };
 *   }
 * }
 *
 * registerErrorDetector(new GotErrorDetector());
 * ```
 */
export function registerErrorDetector(detector: ErrorDetectorAdapter): void {
  globalRegistry.register(detector);
}

/**
 * Type guard to check if error is payment-required
 */
export function isPaymentRequiredError(error: unknown): boolean {
  return globalRegistry.is402Error(error);
}

/**
 * Detects if an AxiosError is a 402 payment error
 * Convenience function for Axios users
 */
export function isAxios402Error(error: unknown): error is AxiosError {
  if (!(error instanceof Error && 'isAxiosError' in error)) {
    return false;
  }

  const axiosError = error as AxiosError;
  return axiosError.response?.status === 402;
}

/**
 * Detects if an HttpError is a 402 payment error
 * Convenience function for generic HTTP error users
 */
export function isHttp402Error(error: unknown): error is HttpError {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return false;
  }

  const httpError = error as HttpError;
  return httpError.status === 402;
}

/**
 * Extracts payment data from various error formats
 */
export function extractPaymentData(error: unknown): PaymentData {
  const info = globalRegistry.extractPaymentInfo(error);
  return info.paymentData;
}

/**
 * Extracts the resource URL from the error
 */
export function extractResourceFromError(error: unknown): string {
  const info = globalRegistry.extractPaymentInfo(error);
  return info.resource;
}

/**
 * Extracts existing transaction ID if present
 */
export function extractTransactionId(error: unknown): string | undefined {
  const info = globalRegistry.extractPaymentInfo(error);
  return info.transactionId;
}

/**
 * Type guard for x402 protocol response
 */
function isX402Response(data: unknown): data is X402PaymentResponse {
  return (
    data !== null &&
    typeof data === 'object' &&
    'x402Version' in data &&
    'accepts' in data &&
    Array.isArray((data as any).accepts)
  );
}

/**
 * Type guard for Sapiom payment response
 */
function isSapiomPaymentResponse(data: unknown): data is SapiomPaymentResponse {
  return (
    data !== null &&
    typeof data === 'object' &&
    'requiresPayment' in data &&
    (data as any).requiresPayment === true &&
    'paymentData' in data
  );
}

/**
 * Converts x402 format to Sapiom PaymentData format
 */
export function convertX402ToPaymentData(x402Response: X402PaymentResponse, requestUrl: string): PaymentData {
  // Select the first payment requirement (could be made configurable)
  const requirement = x402Response.accepts[0];

  if (!requirement) {
    throw new Error('No payment requirements in x402 response');
  }

  return {
    protocol: 'x402',
    network: requirement.network,
    token: extractTokenSymbol(requirement.asset, requirement.network),
    scheme: requirement.scheme,
    amount: requirement.maxAmountRequired,
    payTo: requirement.payTo,
    payToType: 'address', // x402 uses addresses
    protocolMetadata: {
      x402Version: x402Response.x402Version,
      resource: requirement.resource || requestUrl,
      description: requirement.description,
      mimeType: requirement.mimeType,
      maxTimeoutSeconds: requirement.maxTimeoutSeconds,
      asset: requirement.asset,
      originalRequirement: requirement,
    },
  };
}

/**
 * Normalizes various payment data formats to PaymentData
 */
function normalizeToPaymentData(data: any): PaymentData {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid payment data: expected object');
  }

  // Already in correct format
  if (data.protocol && data.network && data.token && data.scheme && data.amount && data.payTo && data.payToType) {
    return data as PaymentData;
  }

  // Try to map common field names
  return {
    protocol: data.protocol || 'x402',
    network: data.network || data.chain || 'base-sepolia',
    token: data.token || data.currency || 'USDC',
    scheme: data.scheme || 'exact',
    amount: String(data.amount || data.price || data.cost || '0'),
    payTo: data.payTo || data.recipient || data.address || data.to,
    payToType: data.payToType || 'address',
    protocolMetadata: data.protocolMetadata || data.metadata,
  };
}

/**
 * Extracts token symbol from asset address and network
 */
function extractTokenSymbol(asset: string, network: string): string {
  // Known token addresses mapping
  const knownTokens: Record<string, Record<string, string>> = {
    'base-sepolia': {
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e': 'USDC',
    },
    base: {
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 'USDC',
    },
    ethereum: {
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 'USDC',
    },
    solana: {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
    },
  };

  const networkTokens = knownTokens[network];
  if (networkTokens && networkTokens[asset]) {
    return networkTokens[asset];
  }

  // Default to USDC as it's most common in x402
  return 'USDC';
}

/**
 * Wraps an async function to convert 402 errors to PaymentRequiredError
 */
export function wrapWith402Detection<T extends (...args: any[]) => Promise<any>>(fn: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (isPaymentRequiredError(error) && !(error instanceof PaymentRequiredError)) {
        // Convert to our standardized error
        const info = globalRegistry.extractPaymentInfo(error);

        throw new PaymentRequiredError(
          'Payment required to access this resource',
          info.paymentData,
          info.resource,
          info.transactionId,
          error as Error,
        );
      }
      throw error;
    }
  }) as T;
}
