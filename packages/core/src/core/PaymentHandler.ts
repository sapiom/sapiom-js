import {
  HttpError,
  HttpRequest,
  HttpResponse,
  SapiomTransactionMetadata,
} from "../http/types";
import {
  extractPaymentData,
  extractResourceFromError,
  extractTransactionId,
  isPaymentRequiredError,
} from "../lib/PaymentErrorDetection";
import { SapiomClient } from "../lib/SapiomClient";
import { TransactionPoller } from "../lib/TransactionPoller";
import { getHeader, setHeader } from "../lib/utils";
import {
  PaymentTransactionResponse,
  TransactionStatus,
} from "../types/transaction";

/**
 * Configuration for PaymentHandler
 */
export interface PaymentHandlerConfig {
  sapiomClient: SapiomClient;

  // Opt-out flag
  enabled?: boolean; // Default: true

  // Optional callbacks for visibility
  onPaymentRequired?: (
    transactionId: string,
    payment: PaymentTransactionResponse,
  ) => void;
  onPaymentSuccess?: (transactionId: string) => void;
  onPaymentFailed?: (error: Error) => void;

  // Advanced options
  maxRetries?: number; // Default: 1
  pollingInterval?: number; // Default: 1000ms
  authorizationTimeout?: number; // Default: 30000ms (30s)
}

/**
 * Core payment handler (HTTP-agnostic)
 * Handles 402 payment errors by creating Sapiom transactions and retrying with payment proof
 */
export class PaymentHandler {
  private poller: TransactionPoller;

  constructor(private config: PaymentHandlerConfig) {
    this.poller = new TransactionPoller(config.sapiomClient, {
      timeout: config.authorizationTimeout,
      pollInterval: config.pollingInterval,
    });
  }

  /**
   * Handles a 402 payment error
   * Returns HttpResponse if payment successful, null if cannot handle
   */
  async handlePaymentError(
    error: HttpError,
    originalRequest: HttpRequest,
    requestExecutor: (request: HttpRequest) => Promise<HttpResponse>,
  ): Promise<HttpResponse | null> {
    // 1. Check if this is a 402 error
    if (!isPaymentRequiredError(error)) {
      return null; // Not a payment error
    }

    // 2. Check retry flag to prevent loops
    if (originalRequest.metadata?.__is402Retry) {
      return null; // Already retried, cannot handle
    }

    try {
      // 3. Extract payment data from error
      const paymentData = extractPaymentData(error);
      const resource = extractResourceFromError(error);

      if (!paymentData || !resource) {
        return null; // Cannot extract payment info
      }

      // Check for existing Sapiom transaction ID from request headers
      // (Don't trust transactionId from error - could be external service's ID)
      const existingTransactionId = getHeader(
        originalRequest.headers,
        "X-Sapiom-Transaction-Id",
      );

      // Get user-provided transaction metadata from request
      const userMetadata = originalRequest.__sapiom;

      // 4. Create or retrieve transaction
      let transaction;
      if (existingTransactionId) {
        transaction = await this.config.sapiomClient.transactions.get(
          existingTransactionId,
        );

        // If transaction exists but doesn't require payment, reauthorize with payment
        if (
          !transaction.requiresPayment &&
          transaction.status === TransactionStatus.AUTHORIZED
        ) {
          transaction =
            await this.config.sapiomClient.transactions.reauthorizeWithPayment(
              existingTransactionId,
              paymentData,
            );
        }
      } else {
        const service =
          userMetadata?.serviceName || this.extractServiceName(resource);

        transaction = await this.config.sapiomClient.transactions.create({
          serviceName: service,
          actionName: userMetadata?.actionName || "access",
          resourceName: userMetadata?.resourceName || resource,
          paymentData,
          traceId: userMetadata?.traceId,
          traceExternalId: userMetadata?.traceExternalId,
          agentId: userMetadata?.agentId,
          agentName: userMetadata?.agentName,
          qualifiers: userMetadata?.qualifiers,
          metadata: {
            ...userMetadata?.metadata,
            originalMethod: originalRequest.method,
            originalUrl: originalRequest.url,
          },
        });
      }

      // 5. Check for denied or cancelled transactions
      if (
        transaction.status === TransactionStatus.DENIED ||
        transaction.status === TransactionStatus.CANCELLED
      ) {
        this.config.onPaymentFailed?.(
          new Error(`Transaction ${transaction.status}: ${transaction.id}`),
        );
        // Return 403 Forbidden for denied/cancelled transactions
        return {
          status: 403,
          statusText: "Forbidden",
          headers: {},
          data: {
            error: "Payment transaction was denied or cancelled",
            transactionId: transaction.id,
            status: transaction.status,
          },
        };
      }

      // 6. Wait for authorization if needed
      if (transaction.status !== TransactionStatus.AUTHORIZED) {
        if (transaction.requiresPayment && transaction.payment) {
          this.config.onPaymentRequired?.(transaction.id, transaction.payment);
        }

        const authResult = await this.poller.waitForAuthorization(
          transaction.id,
        );

        if (authResult.status !== "authorized") {
          this.config.onPaymentFailed?.(
            new Error(`Payment ${authResult.status}: ${transaction.id}`),
          );
          // Return 403 for denied/timeout
          return {
            status: 403,
            statusText: "Forbidden",
            headers: {},
            data: {
              error: `Payment transaction ${authResult.status}`,
              transactionId: transaction.id,
            },
          };
        }

        // Use transaction from polling result (no need to re-fetch)
        transaction = authResult.transaction;
      }

      // 7. Extract authorization payload
      const authorizationPayload = transaction.payment?.authorizationPayload;

      if (!authorizationPayload) {
        throw new Error(
          `Transaction ${transaction.id} is authorized but missing payment authorization payload`,
        );
      }

      // 8. Encode authorization payload for X-PAYMENT header
      // x402 protocol expects: base64(JSON.stringify(authorizationPayload))
      // TODO: back-end should handle this and may need to change based on protocol / network
      const paymentHeaderValue =
        typeof authorizationPayload === "string"
          ? authorizationPayload // Already encoded
          : Buffer.from(JSON.stringify(authorizationPayload)).toString(
              "base64",
            ); // Encode object

      // 9. Retry original request with X-PAYMENT header (case-insensitive safe)
      const retryRequest: HttpRequest = {
        ...originalRequest,
        headers: setHeader(
          originalRequest.headers,
          "X-PAYMENT",
          paymentHeaderValue,
        ),
        metadata: {
          ...originalRequest.metadata,
          __is402Retry: true,
        },
      };

      const response = await requestExecutor(retryRequest);

      // 10. Notify success
      this.config.onPaymentSuccess?.(transaction.id);

      return response;
    } catch (error) {
      // Notify callback but don't swallow the error
      this.config.onPaymentFailed?.(error as Error);

      // Re-throw to preserve error context for debugging
      throw error;
    }
  }

  /**
   * Extracts service name from resource URL
   */
  private extractServiceName(resource: string): string {
    try {
      const url = new URL(resource);
      const pathParts = url.pathname.split("/").filter(Boolean);
      return pathParts[0] || "api";
    } catch {
      return "api";
    }
  }
}
