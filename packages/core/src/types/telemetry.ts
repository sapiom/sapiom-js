/**
 * Shared Telemetry Types
 *
 * Used across all integration schemas (LangChain, HTTP, MCP, etc.)
 */

/**
 * Call site information (anonymized for privacy)
 *
 * Represents a single frame in the call stack showing where code was executed.
 * Array of CallSiteInfo represents the call chain (e.g., [0] = direct, [1] = intermediate, [2] = top-level)
 */
export interface CallSiteInfo {
  /**
   * File path (anonymized - last 2 segments by default)
   * Example: "agents/weather.ts"
   */
  file: string;

  /**
   * Line number
   */
  line: number;

  /**
   * Column number
   */
  column: number;

  /**
   * Function name
   */
  function: string;
}

/**
 * Runtime environment information
 */
export interface RuntimeInfo {
  nodeVersion: string;
  platform: string;
}
