export enum TransactionStatus {
  PENDING = "pending",
  PREPARING = "preparing",
  AUTHORIZED = "authorized",
  COMPLETED = "completed",
  DENIED = "denied",
  CANCELLED = "cancelled",
}

export enum TransactionOutcome {
  SUCCESS = "success",
  ERROR = "error",
}

export interface TransactionCostInput {
  fiatAmount: string;
  fiatAssetSymbol: string;
  isEstimate: boolean;
  costDetails?: Record<string, any>;
}

export interface CreateTransactionRequest {
  requestFacts?: {
    source: string;
    version: string;
    sdk: Record<string, any>;
    request: Record<string, any>;
  };
  serviceName?: string;
  actionName?: string;
  resourceName?: string;
  qualifiers?: Record<string, any>;
  paymentData?: PaymentProtocolData;
  metadata?: Record<string, any>;
  traceId?: string;
  traceExternalId?: string;
  agentId?: string;
  agentName?: string;
  costs?: TransactionCostInput[];
}

export interface PaymentTransactionResponse {
  id: string;
  transactionId: string;
  protocol: string;
  network: string;
  token: string;
  scheme: string;
  amount: string;
  payTo: string;
  payToType: string;
  status: string;
  authorizationPayload?: any;
  protocolMetadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  authorizedAt?: string;
  completedAt?: string;
}

export interface TraceResponse {
  id: string;
  externalId: string | null;
}

export interface TransactionCostResponse {
  id: string;
  transactionId: string;
  organizationId: string;
  fiatAmount: string;
  fiatAssetSymbol: string;
  isEstimate: boolean;
  isActive: boolean;
  supersedesCostId: string | null;
  supersededAt: string | null;
  costDetails: Record<string, any> | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionResponse {
  id: string;
  organizationId: string;
  serviceName: string;
  actionName: string;
  resourceName: string;
  serviceId?: string | null;
  status: TransactionStatus;
  outcome?: TransactionOutcome | null;
  requiresPayment: boolean;
  qualifiers?: Record<string, any>;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  authorizedAt?: string;
  completedAt?: string;
  currentPaymentTransactionId?: string | null;
  payment?: PaymentTransactionResponse;
  trace?: TraceResponse; // Optional for backward compatibility
  costs?: TransactionCostResponse[]; // Optional for backward compatibility
}

export interface ListTransactionsParams {
  status?: TransactionStatus;
  service?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// x402 V1 Types (Legacy)
// ============================================================================

/**
 * V1 Payment Requirement (legacy x402 format)
 * @deprecated Prefer X402PaymentRequirementV2 for new integrations
 */
export interface X402PaymentRequirementV1 {
  scheme: string;
  network: string;
  maxAmountRequired: string;  // V1 field name
  resource: string;           // URL embedded in requirement in V1
  description: string;
  mimeType: string;
  outputSchema?: object | null;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: object | null;
}

/**
 * V1 Response format (from legacy resource servers)
 */
export interface X402ResponseV1 {
  x402Version: 1;
  accepts: X402PaymentRequirementV1[];
}

// ============================================================================
// x402 V2 Types (Current)
// ============================================================================

/**
 * V2 Payment Requirement (new x402 format)
 */
export interface X402PaymentRequirementV2 {
  scheme: string;          // "exact" (or "upto" for pre-auth) in V2
  network: string;         // CAIP-2 format: "sapiom:main" in V2
  amount: string;          // Renamed from maxAmountRequired in V2
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown>; // Required in V2
}

/**
 * V2 Response format (from new resource servers)
 */
export interface X402ResponseV2 {
  x402Version: 2;
  error?: string;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepts: X402PaymentRequirementV2[];
  extensions?: Record<string, unknown>;
}

// ============================================================================
// x402 Union Types (Backward Compatible)
// ============================================================================

/**
 * x402 Payment Requirement (union of V1 and V2)
 * Based on: https://github.com/http-402/x402
 */
export type X402PaymentRequirement =
  | X402PaymentRequirementV1
  | X402PaymentRequirementV2;

/**
 * x402 Protocol Response (union of V1 and V2)
 */
export type X402Response = X402ResponseV1 | X402ResponseV2;

// ============================================================================
// x402 Type Guards
// ============================================================================

/**
 * Check if response is V2 format
 */
export function isV2Response(response: X402Response): response is X402ResponseV2 {
  return response.x402Version === 2;
}

/**
 * Check if response is V1 format
 */
export function isV1Response(response: X402Response): response is X402ResponseV1 {
  return response.x402Version === 1;
}

/**
 * Check if requirement is V2 format
 */
export function isV2Requirement(
  req: X402PaymentRequirement,
): req is X402PaymentRequirementV2 {
  return "amount" in req && !("maxAmountRequired" in req);
}

/**
 * Check if requirement is V1 format
 */
export function isV1Requirement(
  req: X402PaymentRequirement,
): req is X402PaymentRequirementV1 {
  return "maxAmountRequired" in req;
}

// ============================================================================
// x402 Helper Functions
// ============================================================================

/**
 * Get amount from either version (V1 uses maxAmountRequired, V2 uses amount)
 */
export function getPaymentAmount(req: X402PaymentRequirement): string {
  return isV2Requirement(req) ? req.amount : req.maxAmountRequired;
}

/**
 * Get resource URL from response (V1: in requirement, V2: in resource object)
 */
export function getResourceUrl(response: X402Response): string | undefined {
  if (isV2Response(response)) {
    return response.resource.url;
  }
  return response.accepts[0]?.resource;
}

/**
 * Get x402 version from response
 */
export function getX402Version(response: X402Response): 1 | 2 {
  return response.x402Version as 1 | 2;
}

/**
 * Payment Protocol Data
 * Used for both transaction creation with payment and reauthorization
 */
export interface PaymentProtocolData {
  x402: X402Response;
  additionalProtocols?: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * Request data for completing a transaction
 */
export interface CompleteTransactionRequest {
  outcome: "success" | "error";
  responseFacts?: {
    source: string;
    version: string;
    facts: Record<string, any>;
  };
}

/**
 * Result of completing a transaction
 */
export interface CompleteTransactionResult {
  transaction: TransactionResponse;
  factId?: string;
  costId?: string;
}
