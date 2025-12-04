/**
 * MCP Payment Error Detection (x402-mcp protocol)
 *
 * Based on: https://github.com/ethanniser/x402-mcp
 */

/**
 * x402 Payment Response Structure
 * From x402-mcp specification
 */
export interface X402PaymentResponse {
  /**
   * x402 protocol version
   */
  x402Version: number;

  /**
   * Accepted payment methods
   */
  accepts: Array<{
    /**
     * Payment scheme (e.g., "exact", "range")
     */
    scheme: string;

    /**
     * Payment amount (in smallest currency unit)
     */
    amount?: string;

    /**
     * Minimum amount (for range scheme)
     */
    minAmount?: string;

    /**
     * Maximum amount (for range scheme)
     */
    maxAmount?: string;

    /**
     * Currency unit (e.g., "USD", "sats")
     */
    unit?: string;

    /**
     * Payment destination address
     */
    to?: string;

    /**
     * Additional payment metadata
     */
    [key: string]: unknown;
  }>;
}

/**
 * Detects if an error is an MCP payment required error (402)
 *
 * MCP tools return payment errors as ToolException with specific format
 * matching the x402-mcp spec.
 *
 * @param error - Error to check
 * @returns True if error is MCP payment required
 */
export function isMCPPaymentError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as Record<string, unknown>;

  // Check if it's a ToolException-like error
  if (!err.message || typeof err.message !== "string") {
    return false;
  }

  // Try parsing message as JSON (x402 structure)
  try {
    const parsed = JSON.parse(err.message);
    if (parsed.x402Version !== undefined && Array.isArray(parsed.accepts)) {
      return true;
    }
  } catch {
    // Not JSON, check string indicators
  }

  // Check for x402 indicators in message
  const message = err.message;
  return (
    message.includes("x402Version") ||
    message.includes("Payment required") ||
    message.includes("payment_required") ||
    err.code === 402 ||
    err.statusCode === 402
  );
}

/**
 * Extract payment data from MCP error
 *
 * Parses x402 payment response from error message or structured content.
 *
 * @param error - MCP payment error
 * @returns Parsed x402 payment response
 * @throws Error if payment data cannot be extracted
 */
export function extractPaymentFromMCPError(
  error: Record<string, unknown>
): X402PaymentResponse {
  // Try structured content first (if MCP error has it)
  if (error.structuredContent) {
    return error.structuredContent as X402PaymentResponse;
  }

  // Try parsing from error message
  if (typeof error.message === "string") {
    try {
      const parsed = JSON.parse(error.message);
      if (parsed.x402Version && Array.isArray(parsed.accepts)) {
        return {
          x402Version: parsed.x402Version,
          accepts: parsed.accepts,
        };
      }
    } catch {
      // Not valid JSON
    }
  }

  // Try parsing from error data property
  if (error.data) {
    try {
      const data =
        typeof error.data === "string" ? JSON.parse(error.data) : error.data;
      if (
        data &&
        typeof data === "object" &&
        "x402Version" in data &&
        Array.isArray(data.accepts)
      ) {
        return {
          x402Version: data.x402Version,
          accepts: data.accepts,
        };
      }
    } catch {
      // Not valid
    }
  }

  throw new Error(
    `Failed to extract x402 payment data from error: ${error.message}`
  );
}

/**
 * Convert x402 payment response to Sapiom payment format
 *
 * Transforms x402-mcp payment data into Sapiom transaction paymentData.
 *
 * @param x402Payment - x402 payment response
 * @returns Sapiom-compatible payment data
 *
 * @internal
 */
export function convertX402ToSapiomPayment(
  x402Payment: X402PaymentResponse
): Record<string, unknown> {
  // Take first accepted payment method
  const firstAccept = x402Payment.accepts[0];

  return {
    protocol: "x402",
    version: x402Payment.x402Version,
    scheme: firstAccept.scheme,
    amount: firstAccept.amount,
    minAmount: firstAccept.minAmount,
    maxAmount: firstAccept.maxAmount,
    unit: firstAccept.unit || "USD",
    destination: firstAccept.to,
    metadata: {
      ...firstAccept,
      allAcceptedMethods: x402Payment.accepts,
    },
  };
}

/**
 * Extract payment authorization from authorized transaction
 *
 * After payment transaction is authorized, this extracts the authorization
 * payload to include in the retry via _meta["x402/payment"].
 *
 * @param transaction - Authorized payment transaction
 * @returns Payment authorization payload for _meta
 * @throws Error if transaction missing authorizationPayload
 *
 * @internal
 */
export function getPaymentAuthFromTransaction(
  transaction: Record<string, unknown>
): string {
  const payment = transaction.payment as Record<string, unknown> | undefined;
  const authorizationPayload = payment?.authorizationPayload;

  if (!authorizationPayload) {
    throw new Error(
      `Transaction ${transaction.id} is authorized but missing payment.authorizationPayload`
    );
  }

  // authorizationPayload format depends on backend
  // May be string (pre-encoded) or object (need to encode)
  if (typeof authorizationPayload === "string") {
    return authorizationPayload;
  }

  // Encode object as base64 JSON (x402 protocol expects this)
  return Buffer.from(JSON.stringify(authorizationPayload)).toString("base64");
}
