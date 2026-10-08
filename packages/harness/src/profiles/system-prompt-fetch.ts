import {
  fetchServedContent,
  resolveEnvironment,
  servedContentFetchDisabled,
  type ResolvedEnvironment,
} from "@sapiom/mcp/auth";

import { DEFAULT_SYSTEM_PROMPT } from "./default.js";

/** Escape hatch that pins the bundled prompt; see {@link fetchSystemPromptForActiveEnvironment}. */
const PROMPT_FETCH_DISABLED_ENV = "SAPIOM_HARNESS_PROMPT_FETCH_DISABLED";

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
 * The request itself is `fetchServedContent` from `@sapiom/mcp/auth`, the one fetch
 * every served teaching text goes through (SAP-3225).
 */
export async function fetchSystemPrompt(env: ResolvedEnvironment): Promise<string> {
  const served = await fetchServedContent(env, { path: "/v1/harness/system-prompt" });
  return served?.body ?? DEFAULT_SYSTEM_PROMPT;
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
 * pattern telemetry uses there). Spellings match the telemetry opt-outs (`1` or `true`) —
 * a flag that ignored `=true` would stall an air-gapped session for the full timeout on
 * every start, which is the opposite of what the operator asked for. Checked before
 * environment resolution so a disabled run reads no file either.
 */
export async function fetchSystemPromptForActiveEnvironment(
  environment = process.env.SAPIOM_ENVIRONMENT,
): Promise<string> {
  if (servedContentFetchDisabled(PROMPT_FETCH_DISABLED_ENV)) {
    return DEFAULT_SYSTEM_PROMPT;
  }
  try {
    return await fetchSystemPrompt(await resolveEnvironment(environment));
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  }
}
