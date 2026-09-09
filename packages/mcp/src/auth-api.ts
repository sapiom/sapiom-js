/**
 * Public re-export of the browser-OAuth auth flow and credentials store, for
 * consumers that want Sapiom's login without importing the MCP server entry
 * (`index.ts` starts an stdio MCP server as a side effect on import).
 * The path helper lets first-party local hosts observe that same shared store
 * without duplicating its platform-specific location.
 */
export { performBrowserAuth, type AuthResult } from "./auth.js";
export {
  resolveEnvironment,
  readCredentials,
  readCredentialsOrThrow,
  writeCredentials,
  clearCredentials,
  credentialsFilePath,
  type CredentialEntry,
  type EnvironmentConfig,
  type CredentialsFile,
  type ResolvedEnvironment,
} from "./credentials.js";
