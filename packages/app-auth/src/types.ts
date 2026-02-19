/**
 * Configuration for SapiomAuth.
 */
export interface SapiomAuthConfig {
  /** Logical app name, used in x402 API paths (e.g., 'repo-analyzer') */
  appId: string;
  /** App UUID from provision response, used in auth flow URLs */
  appUuid: string;
  /** Gateway base URL (e.g., 'https://auth0.x402.sapiom.ai') */
  gatewayUrl: string;
  /** Server-side only: per-app JWT signing secret from provision response */
  jwtSecret?: string;
  /** Server-side only: Sapiom API key for x402-gated calls (or SAPIOM_API_KEY env) */
  apiKey?: string;
}

/**
 * Decoded JWT session payload. Returned by getUser() and decodeSession().
 */
export interface AuthUser {
  /** Auth0 user ID (subject) */
  sub: string;
  /** Logical app ID */
  appId: string;
  /** Account (tenant) ID */
  accountId: string;
  /** DB session row ID (for revocation) */
  sessionId: string;
  /** Issued at (Unix seconds) */
  iat: number;
  /** Expiration (Unix seconds) */
  exp: number;
}

/**
 * Response from getConnection() — decrypted service access token.
 */
export interface TokenResponse {
  accessToken: string;
  service: string;
  expiresAt: string | null;
  scopes: string[];
}

/**
 * Response from listConnections().
 */
export interface ConnectionsResponse {
  connections: Connection[];
}

/**
 * A single connected service.
 */
export interface Connection {
  service: string;
  connected: boolean;
  scopes: string[];
  expiresAt: string | null;
}

// ─── PostMessage types (used by React components) ───

export interface LoginMessage {
  type: 'sapiom:auth:login';
  sessionToken: string;
  userId: string;
}

export interface ConnectMessage {
  type: 'sapiom:auth:connect';
  service: string;
  connected: boolean;
}

export interface AuthErrorMessage {
  type: 'sapiom:auth:error';
  error: string;
}

export type AuthMessage = LoginMessage | ConnectMessage | AuthErrorMessage;

// ─── Scope catalog ───

export interface ScopeDefinition {
  name: string;
  description: string;
}

export const PROVIDER_SCOPES: Record<string, ScopeDefinition[]> = {
  github: [
    { name: "repo", description: "Full control of private repositories" },
    { name: "read:user", description: "Read user profile data" },
    { name: "user:email", description: "Access user email addresses" },
    { name: "read:org", description: "Read org membership and teams" },
    { name: "gist", description: "Create and manage gists" },
    { name: "workflow", description: "Update GitHub Action workflows" },
    { name: "admin:repo_hook", description: "Full control of repository hooks" },
    { name: "public_repo", description: "Access public repositories only" },
    { name: "notifications", description: "Access notifications" },
  ],
  "google-oauth2": [
    { name: "email", description: "View email address" },
    { name: "profile", description: "View basic profile info" },
    { name: "openid", description: "OpenID Connect authentication" },
    { name: "https://www.googleapis.com/auth/calendar", description: "Manage Google Calendar" },
    { name: "https://www.googleapis.com/auth/drive", description: "Manage Google Drive files" },
    { name: "https://www.googleapis.com/auth/gmail.readonly", description: "Read-only access to Gmail" },
    { name: "https://www.googleapis.com/auth/spreadsheets", description: "Manage Google Sheets" },
  ],
  discord: [
    { name: "identify", description: "Read user info (username, avatar)" },
    { name: "email", description: "Access user email" },
    { name: "guilds", description: "List user guilds (servers)" },
    { name: "guilds.join", description: "Join guilds on behalf of user" },
    { name: "messages.read", description: "Read messages in channels" },
  ],
  slack: [
    { name: "users:read", description: "View users in workspace" },
    { name: "channels:read", description: "View channels in workspace" },
    { name: "chat:write", description: "Send messages as the app" },
    { name: "files:read", description: "View files shared in channels" },
  ],
  linkedin: [
    { name: "openid", description: "OpenID Connect authentication" },
    { name: "profile", description: "Read basic profile" },
    { name: "email", description: "Read primary email" },
    { name: "w_member_social", description: "Post, comment, and react on behalf of user" },
  ],
  twitter: [
    { name: "tweet.read", description: "Read tweets and timeline" },
    { name: "tweet.write", description: "Post and delete tweets" },
    { name: "users.read", description: "Read user profile info" },
    { name: "follows.read", description: "Read following/followers" },
    { name: "offline.access", description: "Maintain access when user is not present" },
  ],
  microsoft: [
    { name: "openid", description: "OpenID Connect authentication" },
    { name: "email", description: "View email address" },
    { name: "profile", description: "View basic profile" },
    { name: "User.Read", description: "Read signed-in user profile" },
    { name: "Mail.Read", description: "Read user mail" },
    { name: "Files.ReadWrite", description: "Read and write user files (OneDrive)" },
    { name: "Calendars.ReadWrite", description: "Read and write user calendars" },
  ],
  apple: [
    { name: "name", description: "Request user's name" },
    { name: "email", description: "Request user's email" },
  ],
};
