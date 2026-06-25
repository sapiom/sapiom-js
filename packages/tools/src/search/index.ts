/**
 * `search` capability — find information across the web and beyond.
 *
 * This is the home for Sapiom's search primitives: searching the web, reading the
 * contents of a page, and looking up professional email addresses. The first
 * operations land here shortly; for now this namespace is intentionally empty.
 *
 *   import { search } from "@sapiom/tools";        // ambient auth
 *
 * Or via an explicit client: `createClient({ apiKey }).search`.
 *
 * Failed requests throw {@link SearchHttpError} (carries `status` + parsed `body`).
 */
import { SearchHttpError } from "./errors.js";

export { SearchHttpError };

// Operations (web search, page reading, email lookup) are added here as they
// ship. Each becomes a named export and the barrel re-exports this module as the
// `search` namespace, so a method reads as `search.webSearch(...)`.
