import { decodeJwt } from './jwt.js';
import type {
  AuthUser,
  ConnectionsResponse,
  SapiomAuthConfig,
  TokenResponse,
} from './types.js';

/**
 * SapiomAuth — main class for app authentication via the Auth0 x402 gateway.
 *
 * Works in both browser and server environments:
 * - Browser: URL builders + decodeSession() (no crypto, no server deps)
 * - Server: getUser() (JWT verify) + getConnection()/listConnections() (x402 calls)
 *
 * Server-only methods use dynamic imports to keep Node.js dependencies
 * (jsonwebtoken, @sapiom/fetch) out of browser bundles.
 */
export class SapiomAuth {
  private readonly config: SapiomAuthConfig;
  private readonly gatewayUrl: string;

  constructor(config: SapiomAuthConfig) {
    this.config = config;
    // Normalize: strip trailing slash
    this.gatewayUrl = config.gatewayUrl.replace(/\/+$/, '');
  }

  // ─── Browser-side URL builders ───

  /** URL to start the login flow (opens Auth0 Universal Login). */
  getLoginUrl(): string {
    return `${this.gatewayUrl}/auth/${this.config.appUuid}/login`;
  }

  /** URL to start the connect flow for a service (opens OAuth provider login). */
  getConnectUrl(service: string, sessionToken: string, scopes?: string[]): string {
    const params = new URLSearchParams({ session_token: sessionToken });
    if (scopes && scopes.length > 0) {
      params.set('scopes', scopes.join(','));
    }
    return `${this.gatewayUrl}/auth/${this.config.appUuid}/connect/${service}?${params.toString()}`;
  }

  /** URL to logout (invalidate session). */
  getLogoutUrl(sessionToken: string): string {
    const params = new URLSearchParams({ session_token: sessionToken });
    return `${this.gatewayUrl}/auth/${this.config.appUuid}/logout?${params.toString()}`;
  }

  // ─── Browser-side JWT decode ───

  /**
   * Decode a JWT session token WITHOUT verification (browser-safe, no crypto).
   * Use for displaying user info only — NOT for authorization.
   */
  decodeSession(sessionToken: string): AuthUser {
    return decodeJwt(sessionToken);
  }

  // ─── Server-side: local JWT verification ───

  /**
   * Verify a session token and return the decoded user.
   * Requires jwtSecret in config.
   *
   * This runs locally (no network call) — free and fast.
   */
  async getUser(sessionToken: string): Promise<AuthUser> {
    if (!sessionToken) {
      throw new Error('sessionToken is required');
    }

    if (!this.config.jwtSecret) {
      throw new Error('jwtSecret is required for server-side getUser(). Pass it in SapiomAuth config.');
    }

    const jwt = await import('jsonwebtoken');
    const decoded = jwt.verify(sessionToken, this.config.jwtSecret, {
      algorithms: ['HS256'],
    });

    const payload = decoded as AuthUser;

    // Verify the token belongs to this app
    if (payload.appId !== this.config.appId) {
      throw new Error('Token was issued for a different app');
    }

    return payload;
  }

  // ─── Server-side: x402-gated calls ───

  /**
   * Get a decrypted access token for a connected service.
   * Makes an x402-gated POST to the gateway.
   */
  async getConnection(sessionToken: string, service: string): Promise<TokenResponse> {
    if (!sessionToken) {
      throw new Error('sessionToken is required');
    }

    const url = `${this.gatewayUrl}/v1/apps/${this.config.appId}/token`;
    const { createFetch } = await import('@sapiom/fetch');
    const fetchFn = createFetch({ apiKey: this.config.apiKey });

    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken, service }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to get connection token: ${response.status} ${body}`);
    }

    return (await response.json()) as TokenResponse;
  }

  /**
   * List a user's connected services.
   * Makes an x402-gated GET to the gateway.
   */
  async listConnections(sessionToken: string): Promise<ConnectionsResponse> {
    if (!sessionToken) {
      throw new Error('sessionToken is required');
    }

    const params = new URLSearchParams({ session_token: sessionToken });
    const url = `${this.gatewayUrl}/v1/apps/${this.config.appId}/connections?${params.toString()}`;
    const { createFetch } = await import('@sapiom/fetch');
    const fetchFn = createFetch({ apiKey: this.config.apiKey });

    const response = await fetchFn(url);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to list connections: ${response.status} ${body}`);
    }

    return (await response.json()) as ConnectionsResponse;
  }
}
