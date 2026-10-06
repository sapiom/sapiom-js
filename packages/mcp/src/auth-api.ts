/**
 * Public re-export of the browser-OAuth auth flow and credentials store, for
 * consumers that want Sapiom's login without importing the MCP server entry
 * (`index.ts` starts an stdio MCP server as a side effect on import).
 * The path helper lets first-party local hosts observe that same shared store
 * without duplicating its platform-specific location. The served-content fetch
 * sits beside `resolveEnvironment` because every caller resolves an environment
 * first and then fetches teaching text from its API host (SAP-3225).
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
  type StudioCredentials,
  type EnvironmentConfig,
  type CredentialsFile,
  type ResolvedEnvironment,
} from "./credentials.js";
export {
  fetchServedContent,
  servedContentFetchDisabled,
  SERVED_CONTENT_FETCH_TIMEOUT_MS,
  type ServedContent,
  type FetchServedContentOptions,
} from "./served-content.js";
export { stripStampFooter } from "./content-stamp.js";
