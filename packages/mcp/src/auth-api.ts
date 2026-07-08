/**
 * Public re-export of the browser-OAuth auth flow and credentials store, for
 * consumers that want Sapiom's login without importing the MCP server entry
 * (`index.ts` starts an stdio MCP server as a side effect on import).
 */
export { performBrowserAuth, type AuthResult } from "./auth.js";
export {
  resolveEnvironment,
  readCredentials,
  writeCredentials,
  clearCredentials,
  type CredentialEntry,
  type EnvironmentConfig,
  type CredentialsFile,
  type ResolvedEnvironment,
} from "./credentials.js";
