// This file contains the core payment error detection logic without HTTP library dependencies
import { HttpError } from "../http/types";
import { PaymentData } from "../types/transaction";

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
 * HTTP library packages should implement this
 */
export interface ErrorDetectorAdapter {
  canHandle(error: unknown): boolean;
  is402Error(error: unknown): boolean;
  extractPaymentInfo(error: unknown): ExtractedPaymentInfo;
}

/**
 * Custom error for payment required
 */
export class PaymentRequiredError extends Error {
  constructor(
    message: string,
    public paymentData: PaymentData,
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

  extractPaymentInfo(error: unknown): ExtractedPaymentInfo {
    if (!this.canHandle(error)) {
      throw new Error("HttpErrorDetector cannot handle this error");
    }

    const httpError = error as HttpError;

    // Try x402 protocol format first
    if (isX402Response(httpError.data)) {
      const paymentData = convertX402ToPaymentData(
        httpError.data,
        httpError.request?.url || "",
      );
      const resource =
        httpError.data.accepts[0]?.resource ||
        httpError.request?.url ||
        "unknown";
      const transactionId = this.extractTransactionId(httpError);
      return { paymentData, resource, transactionId };
    }

    // Try Sapiom format
    if (isSapiomPaymentResponse(httpError.data)) {
      return {
        paymentData: httpError.data.paymentData,
        resource: httpError.request?.url || "unknown",
        transactionId: httpError.data.transactionId,
      };
    }

    // Generic extraction
    return {
      paymentData: normalizeToPaymentData(httpError.data),
      resource: httpError.request?.url || "unknown",
      transactionId: this.extractTransactionId(httpError),
    };
  }

  private extractTransactionId(error: HttpError): string | undefined {
    const data = error.data;

    if (isSapiomPaymentResponse(data)) {
      return data.transactionId;
    }

    if (error.headers?.["x-sapiom-transaction-id"]) {
      return error.headers["x-sapiom-transaction-id"];
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

  detectPaymentError(error: unknown): ExtractedPaymentInfo | null {
    for (const detector of this.detectors) {
      if (detector.canHandle(error) && detector.is402Error(error)) {
        return detector.extractPaymentInfo(error);
      }
    }
    return null;
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
 * Detect if error is a 402 payment error (generic)
 */
export function isPaymentRequiredError(error: unknown): boolean {
  return globalRegistry.detectPaymentError(error) !== null;
}

/**
 * Generic 402 error detection using registered adapters
 */
export function isHttp402Error(error: unknown): boolean {
  return isPaymentRequiredError(error);
}

/**
 * Extract payment data from error using registered adapters
 */
export function extractPaymentData(error: unknown): PaymentData | undefined {
  const info = globalRegistry.detectPaymentError(error);
  return info?.paymentData;
}

/**
 * Extract resource from error
 */
export function extractResourceFromError(error: unknown): string | undefined {
  const info = globalRegistry.detectPaymentError(error);
  return info?.resource;
}

/**
 * Extract transaction ID from error
 */
export function extractTransactionId(error: unknown): string | undefined {
  const info = globalRegistry.detectPaymentError(error);
  return info?.transactionId;
}

/**
 * Convert x402 format to Sapiom PaymentData
 */
export function convertX402ToPaymentData(
  x402: X402PaymentResponse,
  resource: string,
): PaymentData {
  const requirement = x402.accepts[0];
  if (!requirement) {
    throw new Error("No payment requirements in x402 response");
  }

  return {
    protocol: "x402",
    network: requirement.network,
    token: requirement.asset,
    scheme: requirement.scheme as "exact" | "max",
    amount: requirement.maxAmountRequired,
    payTo: requirement.payTo,
    payToType: "address",
    protocolMetadata: {
      x402Version: x402.x402Version,
      resource: requirement.resource || resource,
      description: requirement.description,
      mimeType: requirement.mimeType,
      maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    },
  };
}

/**
 * Wrap a function to detect and throw PaymentRequiredError
 */
export function wrapWith402Detection<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error) => {
    const paymentInfo = globalRegistry.detectPaymentError(error);
    if (paymentInfo) {
      throw new PaymentRequiredError(
        "Payment required",
        paymentInfo.paymentData,
        paymentInfo.resource,
        paymentInfo.transactionId,
      );
    }
    throw error;
  });
}

// Helper functions
function normalizeToPaymentData(data: unknown): PaymentData {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid payment data");
  }

  const obj = data as any;
  return {
    protocol: obj.protocol || "x402",
    network: obj.network || "unknown",
    token: obj.token || obj.asset || "USDC",
    scheme: obj.scheme || "exact",
    amount: obj.amount || obj.maxAmountRequired || "0",
    payTo: obj.payTo || obj.recipient || "unknown",
    payToType: obj.payToType || "address",
    protocolMetadata: obj.protocolMetadata || obj.metadata || {},
  };
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
  extractPaymentInfo(): never {
    throw new Error("AxiosErrorDetector moved to @sapiom/axios package");
  }
}
