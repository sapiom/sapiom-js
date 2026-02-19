/**
 * @sapiom/app-auth — Auth SDK for apps built on Sapiom's Auth0 gateway.
 *
 * @packageDocumentation
 */

export { SapiomAuth } from './sapiom-auth.js';
export { decodeJwt } from './jwt.js';
export { PROVIDER_SCOPES } from './types.js';
export type {
  SapiomAuthConfig,
  AuthUser,
  TokenResponse,
  ConnectionsResponse,
  Connection,
  LoginMessage,
  ConnectMessage,
  AuthErrorMessage,
  AuthMessage,
  ScopeDefinition,
} from './types.js';
