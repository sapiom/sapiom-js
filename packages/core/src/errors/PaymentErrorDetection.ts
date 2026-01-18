// This file contains the core payment error detection logic without HTTP library dependencies
import { HttpError } from "../types/http.js";
import {
  X402PaymentRequirementV1,
  X402PaymentRequirementV2,
  X402ResponseV1,
  X402ResponseV2,
} from "../types/transaction.js";

/**
 * Decode base64 string to UTF-8 (works in both Node.js and browser)
 */
function base64Decode(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "base64").toString("utf-8");
  }
  // Browser fallback
  return decodeURIComponent(
    atob(str)
      .split("")
      .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join("")
  );
}


// ============================================================================
// x402 Payment Response Types (for error detection)
// ============================================================================

/**
 * V1 Payment Requirement (re-exported for error detection)
 */
export type X402PaymentRequirement =
  | X402PaymentRequirementV1
  | X402PaymentRequirementV2;

/**
 * Standard x402 protocol response format (union of V1 and V2)
 */
export type X402PaymentResponse = X402ResponseV1 | X402ResponseV2;

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
  /** The x402 protocol version (1 or 2) */
  public readonly x402Version: number;

  constructor(
    message: string,
    public x402Response: X402PaymentResponse,
    public resource: string,
    public transactionId?: string,
  ) {
    super(message);
    this.name = "PaymentRequiredError";
    this.x402Version = x402Response.x402Version;
  }

  /** Check if this error came from a V2 resource server */
  isV2(): boolean {
    return this.x402Version === 2;
  }

  /** Check if this error came from a V1 resource server */
  isV1(): boolean {
    return this.x402Version === 1;
  }
}

// Type guards
function isX402Response(data: unknown): data is X402PaymentResponse {
  if (data === null || typeof data !== "object") return false;

  const obj = data as Record<string, unknown>;

  // Must have x402Version and accepts array
  if (!("x402Version" in obj) || !("accepts" in obj)) return false;
  if (!Array.isArray(obj.accepts)) return false;

  // V2 requires resource object with url
  if (obj.x402Version === 2) {
    if (!("resource" in obj) || typeof obj.resource !== "object") {
      return false;
    }
    const resource = obj.resource as Record<string, unknown>;
    if (typeof resource.url !== "string") return false;
  }

  return true;
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

    // Try x402 protocol format in response body
    if (isX402Response(httpError.data)) {
      return httpError.data;
    }

    // Try Sapiom format (which may wrap x402)
    if (isSapiomPaymentResponse(httpError.data) && httpError.data.x402) {
      return httpError.data.x402;
    }

    // Try V2 format: payment-required header contains base64-encoded JSON
    const headers = httpError.response?.headers || httpError.headers;
    if (headers) {
      const paymentRequiredHeader = headers["payment-required"];
      if (paymentRequiredHeader && typeof paymentRequiredHeader === "string") {
        try {
          // Decode base64 and parse JSON
          const decoded = base64Decode(paymentRequiredHeader);
          const parsed = JSON.parse(decoded);
          if (isX402Response(parsed)) {
            return parsed;
          }
        } catch {
          // Failed to decode/parse header, continue to other methods
        }
      }
    }

    return undefined;
  }

  extractResource(error: unknown): string | undefined {
    if (!this.canHandle(error)) {
      return undefined;
    }

    const httpError = error as HttpError;

    // Try to get resource from x402 response in body
    if (isX402Response(httpError.data)) {
      // V2: resource URL is at response level
      if (
        httpError.data.x402Version === 2 &&
        "resource" in httpError.data &&
        httpError.data.resource?.url
      ) {
        return httpError.data.resource.url;
      }
      // V1: resource URL is in first requirement
      const firstAccept = httpError.data.accepts[0];
      if (firstAccept && "resource" in firstAccept) {
        return firstAccept.resource || httpError.request?.url;
      }
      return httpError.request?.url;
    }

    // Try V2 format: payment-required header contains base64-encoded JSON
    const headers = httpError.response?.headers || httpError.headers;
    if (headers) {
      const paymentRequiredHeader = headers["payment-required"];
      if (paymentRequiredHeader && typeof paymentRequiredHeader === "string") {
        try {
          const decoded = base64Decode(paymentRequiredHeader);
          const parsed = JSON.parse(decoded);
          if (isX402Response(parsed)) {
            if (parsed.x402Version === 2 && "resource" in parsed && parsed.resource?.url) {
              return parsed.resource.url;
            }
            const firstAccept = parsed.accepts[0];
            if (firstAccept && "resource" in firstAccept) {
              return firstAccept.resource || httpError.request?.url;
            }
          }
        } catch {
          // Failed to decode/parse header
        }
      }
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

    const headers = httpError.response?.headers || httpError.headers;
    if (headers?.["x-sapiom-transaction-id"]) {
      return headers["x-sapiom-transaction-id"];
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
