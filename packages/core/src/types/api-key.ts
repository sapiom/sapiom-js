export interface CreateTransactionKeyRequest {
  name: string;
  description?: string;
}

export interface ApiKeyResponse {
  id: string;
  name: string;
  description?: string;
  type: string;
  permissions: string[];
  tenantId: string;
  createdAt: string;
  revokedAt?: string;
}

export interface CreateApiKeyResponse {
  apiKey: ApiKeyResponse;
  plainKey: string;
}
