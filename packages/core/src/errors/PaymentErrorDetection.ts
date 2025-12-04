// This file contains the core payment error detection logic without HTTP library dependencies
import { HttpError } from "../types/http";

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
  description: string;
  mimeType: string;
  outputSchema?: object | null;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: object | null;
}

/**
 * Sapiom-specific payment response format
 */
export interface SapiomPaymentResponse {
  requiresPayment: true;
  transactionId?: string;
  x402?: X402PaymentResponse;
  message?: string;
}

/**
 * Error detector adapter interface
 * HTTP library packages should implement this
 */
export interface ErrorDetectorAdapter {
  canHandle(error: unknown): boolean;
  is402Error(error: unknown): boolean;
  extractX402(error: unknown): X402PaymentResponse | undefined;
  extractResource(error: unknown): string | undefined;
  extractTransactionId(error: unknown): string | undefined;
}

/**
 * Custom error for payment required
 */
export class PaymentRequiredError extends Error {
  constructor(
    message: string,
    public x402Response: X402PaymentResponse,
    public resource: string,
    public transactionId?: string,
  ) {
    super(message);
    this.name = "PaymentRequiredError";
  }
}

// Type guards
function isX402Response(data: unknown): data is X402PaymentResponse {
  return (
    data !== null &&
    typeof data === "object" &&
    "x402Version" in data &&
    "accepts" in data &&
    Array.isArray((data as any).accepts)
  );
}

function isSapiomPaymentResponse(data: unknown): data is SapiomPaymentResponse {
  return (
    data !== null &&
    typeof data === "object" &&
    "requiresPayment" in data &&
    (data as any).requiresPayment === true &&
    "paymentData" in data
  );
}

/**
 * Generic HTTP error detector adapter
 */
export class HttpErrorDetector implements ErrorDetectorAdapter {
  canHandle(error: unknown): boolean {
    return (
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      "message" in error
    );
  }

  is402Error(error: unknown): boolean {
    if (!this.canHandle(error)) return false;
    const httpError = error as HttpError;
    return httpError.status === 402;
  }

  extractX402(error: unknown): X402PaymentResponse | undefined {
    if (!this.canHandle(error)) {
      return undefined;
    }

    const httpError = error as HttpError;

    // Try x402 protocol format
    if (isX402Response(httpError.data)) {
      return httpError.data;
    }

    // Try Sapiom format (which may wrap x402)
    if (isSapiomPaymentResponse(httpError.data) && httpError.data.x402) {
      return httpError.data.x402;
    }

    return undefined;
  }

  extractResource(error: unknown): string | undefined {
    if (!this.canHandle(error)) {
      return undefined;
    }

    const httpError = error as HttpError;

    // Try to get resource from x402 response
    if (isX402Response(httpError.data)) {
      return httpError.data.accepts[0]?.resource || httpError.request?.url;
    }

    // Fall back to request URL
    return httpError.request?.url || "unknown";
  }

  extractTransactionId(error: unknown): string | undefined {
    if (!this.canHandle(error)) {
      return undefined;
    }

    const httpError = error as HttpError;
    const data = httpError.data;

    if (isSapiomPaymentResponse(data)) {
      return data.transactionId;
    }

    if (httpError.headers?.["x-sapiom-transaction-id"]) {
      return httpError.headers["x-sapiom-transaction-id"];
    }

    if (data && typeof data === "object") {
      return (data as any).transactionId || (data as any).transaction_id;
    }

    return undefined;
  }
}

/**
 * Global error detector registry
 */
class PaymentErrorDetectionRegistry {
  private detectors: ErrorDetectorAdapter[] = [];

  constructor() {
    // Register generic HTTP error detector
    this.register(new HttpErrorDetector());
  }

  register(detector: ErrorDetectorAdapter): void {
    this.detectors.unshift(detector);
  }

  is402Error(error: unknown): boolean {
    for (const detector of this.detectors) {
      if (detector.canHandle(error) && detector.is402Error(error)) {
        return true;
      }
    }
    return false;
  }

  extractX402(error: unknown): X402PaymentResponse | undefined {
    for (const detector of this.detectors) {
      if (detector.canHandle(error) && detector.is402Error(error)) {
        return detector.extractX402(error);
      }
    }
    return undefined;
  }

  extractResource(error: unknown): string | undefined {
    for (const detector of this.detectors) {
      if (detector.canHandle(error) && detector.is402Error(error)) {
        return detector.extractResource(error);
      }
    }
    return undefined;
  }

  extractTransactionId(error: unknown): string | undefined {
    for (const detector of this.detectors) {
      if (detector.canHandle(error) && detector.is402Error(error)) {
        return detector.extractTransactionId(error);
      }
    }
    return undefined;
  }
}

const globalRegistry = new PaymentErrorDetectionRegistry();

/**
 * Register a custom error detector
 */
export function registerErrorDetector(detector: ErrorDetectorAdapter): void {
  globalRegistry.register(detector);
}

/**
 * Detect if error is a 402 payment error
 */
export function isPaymentRequiredError(error: unknown): boolean {
  return globalRegistry.is402Error(error);
}

/**
 * Generic 402 error detection using registered adapters
 */
export function isHttp402Error(error: unknown): boolean {
  return isPaymentRequiredError(error);
}

/**
 * Extract resource from error
 */
export function extractResourceFromError(error: unknown): string | undefined {
  return globalRegistry.extractResource(error);
}

/**
 * Extract transaction ID from error
 */
export function extractTransactionId(error: unknown): string | undefined {
  return globalRegistry.extractTransactionId(error);
}

/**
 * Extract raw x402 response from error
 * Returns the full x402 protocol response without pre-processing
 *
 * @param error - HTTP error that might contain x402 data
 * @returns X402 response object or undefined if not present
 */
export function extractX402Response(error: unknown): X402PaymentResponse | undefined {
  return globalRegistry.extractX402(error);
}

/**
 * Wrap a function to detect and throw PaymentRequiredError
 */
export function wrapWith402Detection<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error) => {
    const x402 = globalRegistry.extractX402(error);
    const resource = globalRegistry.extractResource(error);
    const transactionId = globalRegistry.extractTransactionId(error);

    if (x402 && resource) {
      throw new PaymentRequiredError(
        "Payment required",
        x402,
        resource,
        transactionId,
      );
    }
    throw error;
  });
}

// Re-export for backwards compatibility (will be moved to axios package)
export function isAxios402Error(_error: unknown): boolean {
  // This is a stub - actual implementation in @sapiom/axios
  return false;
}

// Re-export AxiosErrorDetector class name for type compatibility
export class AxiosErrorDetector implements ErrorDetectorAdapter {
  canHandle(): boolean {
    return false;
  }
  is402Error(): boolean {
    return false;
  }
  extractX402(): never {
    throw new Error("AxiosErrorDetector moved to @sapiom/axios package");
  }
  extractResource(): never {
    throw new Error("AxiosErrorDetector moved to @sapiom/axios package");
  }
  extractTransactionId(): never {
    throw new Error("AxiosErrorDetector moved to @sapiom/axios package");
  }
}
