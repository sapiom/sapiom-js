export interface SecretInput {
  value: string;
}

export interface SetManyRequest {
  entries: Record<string, SecretInput>;
}

export interface SecretResponse {
  key: string;
  value: string;
}
