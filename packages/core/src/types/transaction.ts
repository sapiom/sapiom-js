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

/**
 * x402 Payment Requirement
 * Based on: https://github.com/http-402/x402
 */
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
 * x402 Protocol Response
 */
export interface X402Response {
  x402Version: number;
  accepts: X402PaymentRequirement[];
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
