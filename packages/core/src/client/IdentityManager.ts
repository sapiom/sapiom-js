import { HttpClient } from "./HttpClient.js";

/**
 * Options for configuring the IdentityManager
 */
export interface IdentityManagerOptions {
  /**
   * Enable proactive timer-based token refresh for long-running servers.
   * When enabled, a background timer periodically refreshes the token
   * before it expires, using `unref()` to avoid preventing clean process exit.
   * Default: false (optimistic refresh on each request)
   */
  backgroundRefresh?: boolean;
}

interface CachedToken {
  jwt: string;
  expiresAt: Date;
  audiences: string[];
}

/** Minimum remaining TTL before triggering an async background refresh */
const REFRESH_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

/** How often the background timer checks for refresh (when backgroundRefresh is enabled) */
const BACKGROUND_REFRESH_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Manages identity token lifecycle for Sapiom SDK.
 *
 * - Lazily fetches tokens from `POST /v1/auth/tokens`
 * - Caches in-memory with expiry tracking
 * - Audience matching: direct hostname match + subdomain match
 * - Refresh: blocks if expired, async if near-expiry (< 3min)
 * - Graceful degradation: proceeds without identity if facilitator is unreachable
 */
export class IdentityManager {
  private readonly httpClient: HttpClient;
  private readonly backgroundRefresh: boolean;

  private cached: CachedToken | null = null;
  private inFlightFetch: Promise<CachedToken | null> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(httpClient: HttpClient, options?: IdentityManagerOptions) {
    this.httpClient = httpClient;
    this.backgroundRefresh = options?.backgroundRefresh ?? false;

    if (this.backgroundRefresh) {
      this.startBackgroundRefresh();
    }
  }

  /**
   * Get the current identity token, fetching lazily if needed.
   * Returns null if the facilitator is unreachable.
   */
  async getToken(): Promise<{
    identity: string;
    identityExpiresAt: string;
  } | null> {
    const token = await this.resolveToken();
    if (!token) return null;
    return {
      identity: token.jwt,
      identityExpiresAt: token.expiresAt.toISOString(),
    };
  }

  /**
   * Check if the identity header should be attached for the given hostname.
   * Performs direct match and subdomain match against token `aud` entries.
   */
  shouldAttachHeader(targetHostname: string): boolean {
    if (!this.cached) return false;
    return this.matchesAudience(targetHostname, this.cached.audiences);
  }

  /**
   * Convenience method: resolves the token and returns the `Sapiom-Identity` header
   * if the target URL's hostname matches the token audience. Returns empty object otherwise.
   */
  async getHeaderIfMatch(targetUrl: string): Promise<Record<string, string>> {
    const hostname = this.extractHostname(targetUrl);
    if (!hostname) return {};

    const token = await this.resolveToken();
    if (!token) return {};

    if (this.matchesAudience(hostname, token.audiences)) {
      return { "Sapiom-Identity": token.jwt };
    }

    return {};
  }

  /**
   * Clean up background refresh timer. Call when done with the manager.
   */
  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async resolveToken(): Promise<CachedToken | null> {
    // Healthy cached token
    if (this.cached && !this.isExpired(this.cached)) {
      // Near-expiry: return current but trigger async refresh
      if (this.isNearExpiry(this.cached)) {
        this.triggerAsyncRefresh();
      }
      return this.cached;
    }

    // Expired or no token — block and fetch
    return this.fetchToken();
  }

  private async fetchToken(): Promise<CachedToken | null> {
    // Mutex: reuse in-flight fetch if one exists
    if (this.inFlightFetch) {
      return this.inFlightFetch;
    }

    this.inFlightFetch = this.doFetchToken();

    try {
      return await this.inFlightFetch;
    } finally {
      this.inFlightFetch = null;
    }
  }

  private async doFetchToken(): Promise<CachedToken | null> {
    try {
      const response = await this.httpClient.request<{
        identity: string;
        identityExpiresAt: string;
      }>({
        method: "POST",
        url: "/auth/tokens",
      });

      const audiences = this.decodeAudiences(response.identity);
      const cached: CachedToken = {
        jwt: response.identity,
        expiresAt: new Date(response.identityExpiresAt),
        audiences,
      };

      this.cached = cached;
      return cached;
    } catch {
      // Graceful degradation: facilitator unreachable → proceed without identity
      return null;
    }
  }

  private triggerAsyncRefresh(): void {
    // Fire-and-forget — don't block the caller
    if (this.inFlightFetch) return; // already refreshing
    this.inFlightFetch = this.doFetchToken();
    this.inFlightFetch.finally(() => {
      this.inFlightFetch = null;
    });
  }

  private startBackgroundRefresh(): void {
    this.refreshTimer = setInterval(() => {
      if (this.cached && this.isNearExpiry(this.cached)) {
        this.triggerAsyncRefresh();
      }
    }, BACKGROUND_REFRESH_INTERVAL_MS);

    // unref() so the timer doesn't prevent clean process exit
    if (
      this.refreshTimer &&
      typeof this.refreshTimer === "object" &&
      "unref" in this.refreshTimer
    ) {
      (this.refreshTimer as NodeJS.Timeout).unref();
    }
  }

  private isExpired(token: CachedToken): boolean {
    return Date.now() >= token.expiresAt.getTime();
  }

  private isNearExpiry(token: CachedToken): boolean {
    return token.expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS;
  }

  /**
   * Decode `aud` claim from JWT payload without crypto verification.
   * Handles both string and string[] `aud` formats.
   */
  private decodeAudiences(jwt: string): string[] {
    try {
      const parts = jwt.split(".");
      if (parts.length !== 3) return [];

      const payload = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf-8"),
      );

      const aud = payload.aud;
      if (!aud) return [];
      if (typeof aud === "string") return [aud];
      if (Array.isArray(aud))
        return aud.filter((a: unknown) => typeof a === "string");
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Match hostname against audience entries.
   * Supports direct match and subdomain match
   * (e.g., `fal.services.sapiom.ai` matches `aud` entry `services.sapiom.ai`).
   */
  private matchesAudience(hostname: string, audiences: string[]): boolean {
    const lower = hostname.toLowerCase();
    for (const aud of audiences) {
      const audLower = aud.toLowerCase();
      if (lower === audLower) return true;
      if (lower.endsWith(`.${audLower}`)) return true;
    }
    return false;
  }

  private extractHostname(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }
}
