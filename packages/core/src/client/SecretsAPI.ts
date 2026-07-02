import type {
  SecretInput,
  SecretResponse,
  SetManyRequest,
} from "../types/secret.js";
import type { HttpClient } from "./HttpClient.js";

export class SecretsAPI {
  constructor(private readonly httpClient: HttpClient) {}

  /**
   * Get all secrets stored under a ref.
   *
   * @param ref - External ref for the secret set
   * @returns A flat map of secret key to value
   */
  async getAll(ref: string): Promise<Record<string, string>> {
    return await this.httpClient.request<Record<string, string>>({
      method: "GET",
      url: `/v2/secrets/${encodeURIComponent(ref)}`,
    });
  }

  /**
   * Get a subset of secrets stored under a ref.
   *
   * Passing an empty keys array sends `keys=` and returns the API's empty subset.
   *
   * @param ref - External ref for the secret set
   * @param keys - Secret keys to retrieve
   * @returns A flat map of secret key to value
   */
  async getMany(
    ref: string,
    keys: string[],
  ): Promise<Record<string, string>> {
    return await this.httpClient.request<Record<string, string>>({
      method: "GET",
      url: `/v2/secrets/${encodeURIComponent(ref)}`,
      params: { keys: keys.join(",") },
    });
  }

  /**
   * Get one secret value by ref and key.
   *
   * @param ref - External ref for the secret set
   * @param key - Secret key to retrieve
   * @returns The secret value, or null when the key is absent
   */
  async get(ref: string, key: string): Promise<string | null> {
    try {
      const response = await this.httpClient.request<SecretResponse>({
        method: "GET",
        url: `/v2/secrets/${encodeURIComponent(ref)}/${encodeURIComponent(key)}`,
      });
      return response.value;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Merge a batch of secrets into the set stored under a ref.
   *
   * @param ref - External ref for the secret set
   * @param entries - Secret entries to create or overwrite
   */
  async setMany(
    ref: string,
    entries: Record<string, SecretInput>,
  ): Promise<void> {
    const body: SetManyRequest = { entries };
    await this.httpClient.request<void>({
      method: "POST",
      url: `/v2/secrets/${encodeURIComponent(ref)}`,
      body,
    });
  }

  /**
   * Set or overwrite one secret value.
   *
   * @param ref - External ref for the secret set
   * @param key - Secret key to set
   * @param input - Secret value to store
   */
  async set(ref: string, key: string, input: SecretInput): Promise<void> {
    await this.httpClient.request<void>({
      method: "PUT",
      url: `/v2/secrets/${encodeURIComponent(ref)}/${encodeURIComponent(key)}`,
      body: input,
    });
  }

  /**
   * Delete one secret key. The API treats missing keys as a successful no-op.
   *
   * @param ref - External ref for the secret set
   * @param key - Secret key to delete
   */
  async deleteKey(ref: string, key: string): Promise<void> {
    await this.httpClient.request<void>({
      method: "DELETE",
      url: `/v2/secrets/${encodeURIComponent(ref)}/${encodeURIComponent(key)}`,
    });
  }

  private isNotFoundError(error: unknown): boolean {
    return (
      error instanceof Error &&
      /Request failed with status 404\b/.test(error.message)
    );
  }
}
