export enum TransactionStatus {
  PENDING = 'pending',
  PREPARING = 'preparing',
  AUTHORIZED = 'authorized',
  DENIED = 'denied',
  CANCELLED = 'cancelled',
}

export interface PaymentData {
  protocol: string;
  network: string;
  token: string;
  scheme: string;
  amount: string;
  payTo: string;
  payToType: string;
  protocolMetadata?: Record<string, any>;
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
  paymentData?: PaymentData;
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
  requiresPayment: boolean;
  qualifiers?: Record<string, any>;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  authorizedAt?: string;
  completedAt?: string;
  currentPaymentTransactionId?: string | null;
  payment?: PaymentTransactionResponse;
  trace?: TraceResponse;  // Optional for backward compatibility
  costs?: TransactionCostResponse[];  // Optional for backward compatibility
}

export interface ListTransactionsParams {
  status?: TransactionStatus;
  service?: string;
  limit?: number;
  offset?: number;
}

export interface ReauthorizeWithPaymentRequest {
  protocol: string;
  network: string;
  token: string;
  scheme: string;
  amount: string;
  payTo: string;
  payToType: string;
  protocolMetadata?: Record<string, any>;
}
