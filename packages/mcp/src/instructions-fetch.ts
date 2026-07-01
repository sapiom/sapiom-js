import type { ResolvedEnvironment } from "./credentials.js";
import { AUTHORING_INSTRUCTIONS } from "./instructions.js";

/** How long to wait for the instructions endpoint before falling back. */
const FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch the authoring instructions from the Sapiom backend
 * (`GET {apiURL}/v1/mcp/instructions`, public / no auth), so the guidance a
 * coding agent receives on connect can change without republishing this package.
 *
 * Falls back to the bundled {@link AUTHORING_INSTRUCTIONS} on any failure — a
 * non-200, an empty body, a network error, or a timeout. Never throws: the MCP
 * server must always start with usable instructions, online or off.
 */
export async function fetchInstructions(env: ResolvedEnvironment): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.apiURL}/v1/mcp/instructions`, {
      headers: { Accept: "text/markdown, text/plain" },
      signal: controller.signal,
    });
    if (!response.ok) return AUTHORING_INSTRUCTIONS;
    const body = (await response.text()).trim();
    return body.length > 0 ? body : AUTHORING_INSTRUCTIONS;
  } catch {
    return AUTHORING_INSTRUCTIONS;
  } finally {
    clearTimeout(timeout);
  }
}
