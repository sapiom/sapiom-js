/**
 * Shared Telemetry Utilities
 *
 * Used across all integrations (LangChain, HTTP, MCP, etc.) for capturing
 * call sites and runtime information.
 */

import type { CallSiteInfo, RuntimeInfo } from "../types/telemetry";

/**
 * Capture user call site from stack trace
 *
 * Filters out SDK and library frames to find user code locations.
 * Anonymizes paths by default (last 2 segments only).
 *
 * Returns array of call sites showing the call chain:
 * - [0]: Direct call site (e.g., agents/weather.ts:45)
 * - [1]: Intermediate caller (e.g., lib/helpers.ts:23)
 * - [2]: Top-level caller (e.g., api/chat.ts:12)
 *
 * @param anonymize - Whether to anonymize file paths (default: true)
 * @param depth - Number of stack frames to capture (default: 3)
 * @returns Array of call site info or null if not available
 */
export function captureUserCallSite(
  anonymize = true,
  depth = 3,
): CallSiteInfo[] | null {
  try {
    const stack = new Error().stack;
    if (!stack) return null;

    const frames = stack.split("\n").slice(1); // Skip "Error"

    const userFrames: CallSiteInfo[] = [];

    for (const frame of frames) {
      // Skip SDK code (both as external package and in local development)
      if (frame.includes("node_modules/@sapiom/sdk")) continue;
      if (frame.includes("@sapiom/sdk")) continue;
      if (frame.includes("/sdk/src/")) continue; // Local monorepo development
      if (frame.includes("/sdk/dist/")) continue; // Built SDK in monorepo

      // Skip other node_modules
      if (frame.includes("node_modules/")) continue;

      // Skip Node.js internals (prefixed with "node:")
      if (frame.includes("node:internal/")) continue;
      if (frame.includes("node:async_hooks")) continue;
      if (frame.includes("node:timers")) continue;

      // Parse frame: "    at functionName (/path/to/file.ts:123:45)"
      // Also handles: "    at /path/to/file.ts:123:45" (anonymous)
      const matchWithFunction = frame.match(
        /at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/,
      );
      const matchWithoutFunction = frame.match(/at\s+(.+?):(\d+):(\d+)/);

      let parsed: {
        functionName: string;
        filePath: string;
        line: number;
        column: number;
      } | null = null;

      if (matchWithFunction) {
        const [, functionName, filePath, line, column] = matchWithFunction;
        parsed = {
          functionName,
          filePath,
          line: parseInt(line),
          column: parseInt(column),
        };
      } else if (matchWithoutFunction) {
        const [, filePath, line, column] = matchWithoutFunction;
        parsed = {
          functionName: "<anonymous>",
          filePath,
          line: parseInt(line),
          column: parseInt(column),
        };
      }

      if (parsed) {
        // Skip if this looks like a Node.js built-in module
        // Node built-ins: "async_hooks", "process/task_queues", "timers", etc.
        // They appear without leading "/" and without file extension
        const isNodeBuiltin =
          !parsed.filePath.startsWith("/") && // Not absolute path
          !parsed.filePath.match(/^[A-Z]:\\/) && // Not Windows path
          !parsed.filePath.includes("."); // No file extension

        if (isNodeBuiltin) {
          continue;
        }

        const anonymizedPath = anonymize
          ? anonymizePath(parsed.filePath)
          : relativizePath(parsed.filePath);

        userFrames.push({
          file: anonymizedPath,
          line: parsed.line,
          column: parsed.column,
          function: parsed.functionName,
        });

        if (userFrames.length >= depth) {
          break;
        }
      }
    }

    return userFrames.length > 0 ? userFrames : null;
  } catch (error) {
    // Silently fail - telemetry should never break user code
    return null;
  }
}

/**
 * Anonymize file path to last N segments (default: 2)
 * Example: /Users/john/my-app/src/agents/weather.ts → agents/weather.ts
 */
function anonymizePath(filePath: string, segments = 2): string {
  const parts = filePath.split("/").filter(Boolean);
  return parts.slice(-segments).join("/");
}

/**
 * Relativize path (remove absolute prefix, keep 3 segments)
 * Example: /Users/john/my-app/src/agents/weather.ts → src/agents/weather.ts
 */
function relativizePath(filePath: string, segments = 3): string {
  const parts = filePath.split("/").filter(Boolean);
  return parts.slice(-segments).join("/");
}

/**
 * Get runtime environment info
 */
export function getRuntimeInfo(): RuntimeInfo {
  return {
    nodeVersion: process.version,
    platform: process.platform,
  };
}
