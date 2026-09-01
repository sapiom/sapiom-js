import { resolveEnvironment, type ResolvedEnvironment } from "@sapiom/mcp/auth";

import { isEnvFlagSet } from "../cli/consent.js";
import { DEFAULT_SYSTEM_PROMPT } from "./default.js";

/** How long to wait for the system-prompt endpoint before falling back. */
const FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch the Agent Studio coding-agent system prompt from the Sapiom backend
 * (`GET {apiURL}/v1/harness/system-prompt`, public / no auth), so the conventions
 * a Studio session teaches its coding agent can change without republishing this
 * package (SAP-2810 — improvements used to reach only users who upgraded).
 *
 * Falls back to the bundled {@link DEFAULT_SYSTEM_PROMPT} on any failure — a
 * non-200, an empty body, a network error, or a timeout. Never throws: a session
 * must always launch with a usable prompt, online or off.
 *
 * Mirrors `fetchInstructions` in `@sapiom/mcp` (packages/mcp/src/instructions-fetch.ts),
 * deliberately: the two are the same mechanism on the two client surfaces.
 */
export async function fetchSystemPrompt(env: ResolvedEnvironment): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.apiURL}/v1/harness/system-prompt`, {
      headers: { Accept: "text/markdown, text/plain" },
      signal: controller.signal,
    });
    if (!response.ok) return DEFAULT_SYSTEM_PROMPT;
    const body = (await response.text()).trim();
    return body.length > 0 ? body : DEFAULT_SYSTEM_PROMPT;
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * {@link fetchSystemPrompt} against the active environment (`SAPIOM_ENVIRONMENT`,
 * else whatever the shared credential store names, else production) — the form the
 * server calls per session start. Environment resolution reads a file, so it falls
 * back to the bundled prompt rather than throwing when the store is unreadable.
 *
 * `SAPIOM_HARNESS_PROMPT_FETCH_DISABLED=1` (or `true`) pins the bundled prompt and skips
 * the request entirely: an escape hatch for an air-gapped run, and how the test suite
 * keeps every `startServer` spec off the network (set in src/test-setup.ts, the same
 * pattern telemetry uses there). Spellings match the telemetry opt-outs, via the same
 * `isEnvFlagSet` — a flag that ignored `=true` would stall an air-gapped session for the
 * full timeout on every start, which is the opposite of what the operator asked for.
 */
export async function fetchSystemPromptForActiveEnvironment(
  environment = process.env.SAPIOM_ENVIRONMENT,
): Promise<string> {
  if (isEnvFlagSet(process.env.SAPIOM_HARNESS_PROMPT_FETCH_DISABLED)) {
    return DEFAULT_SYSTEM_PROMPT;
  }
  try {
    return await fetchSystemPrompt(await resolveEnvironment(environment));
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  }
}
