export interface VaultSecretInput {
  value: string;
}

export interface SetVaultSecretsRequest {
  entries: Record<string, VaultSecretInput>;
}

export interface VaultSecretResponse {
  key: string;
  value: string;
}
