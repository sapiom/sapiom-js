import type {
  CreateTransactionKeyRequest,
  CreateApiKeyResponse,
} from "../types/api-key.js";
import type { HttpClient } from "./HttpClient.js";

export class ApiKeyAPI {
  constructor(private readonly httpClient: HttpClient) {}

  /**
   * Create a new API key scoped to transaction creation only.
   *
   * The returned `plainKey` is shown exactly once and cannot be retrieved again.
   *
   * @param data - The key name and optional description
   * @returns The created API key metadata and the raw plainKey
   */
  async createTransactionKey(
    data: CreateTransactionKeyRequest,
  ): Promise<CreateApiKeyResponse> {
    return await this.httpClient.request<CreateApiKeyResponse>({
      method: "POST",
      url: "/api-keys/transaction",
      body: data,
    });
  }
}
