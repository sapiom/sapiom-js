/**
 * HTTP Client Facts Schema V1
 *
 * Schema for tracking HTTP requests through Sapiom.
 *
 * Schema: source="http-client", version="v1"
 */

import type { CallSiteInfo } from "../../../types/telemetry";

/**
 * Request facts (pre-execution)
 */
export interface HttpClientRequestFacts {
  // HTTP request metadata
  method: string;
  url: string;

  // Parsed URL components (for backend inference)
  urlParsed: {
    protocol: string;
    hostname: string;
    pathname: string;
    search: string;
    port: number | null;
  };

  // Headers (sanitized - no auth tokens!)
  headers: Record<string, string>;

  // Body metadata (no actual content!)
  hasBody: boolean;
  bodySizeBytes?: number;
  contentType?: string;

  // Client type
  clientType: "fetch" | "axios" | "node-http";

  // Call site (depth=3 for call chain)
  callSite: CallSiteInfo[] | null;

  // Timestamp
  timestamp: string;
}

/**
 * Response facts (post-execution)
 */
export interface HttpClientResponseFacts {
  // Response metadata
  status: number;
  statusText: string;

  // Response headers (sanitized)
  headers: Record<string, string>;

  // Body metadata (no actual content!)
  bodySizeBytes?: number;
  contentType?: string;

  // Timing
  durationMs: number;
}

/**
 * Error facts
 */
export interface HttpClientErrorFacts {
  errorType: string;
  errorMessage: string;

  // HTTP error details
  httpStatus?: number;
  httpStatusText?: string;

  // Network errors
  isNetworkError: boolean;
  isTimeout: boolean;

  // Timing
  elapsedMs: number;
}

/**
 * Complete HTTP Client facts package
 */
export interface HttpClientFacts {
  source: "http-client";
  version: "v1";

  sdk: {
    name: "@sapiom/sdk";
    version: string;
  };

  request: HttpClientRequestFacts;
  response?: HttpClientResponseFacts;
  error?: HttpClientErrorFacts;
}
