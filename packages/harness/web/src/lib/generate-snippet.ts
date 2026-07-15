/**
 * generateSnippet — pure builder for the "trigger from your code" snippets shown
 * after a deploy (the F1 panel). No I/O, no React — just strings — so it is
 * unit- and mutation-testable in isolation.
 *
 * Every entry point (the harness Prod Run button, the SDK, and this cURL) hits
 * the SAME executions API, so the two snippets are just the two code doorways to
 * it. The constants below are ground-truth-verified and must not drift:
 *   - auth header is `x-api-key` (NOT `Authorization: Bearer` — the /v1 guard
 *     reads x-api-key)
 *   - base is `https://api.sapiom.ai`
 *   - path is `/agents/v1/definitions/{definition}/executions` with body
 *     `{ "input": … }` (NOT `/triggers` — that's scheduling, out of scope)
 *   - the key is ALWAYS the literal placeholder `YOUR_SAPIOM_API_KEY`, never a
 *     real key.
 */

/** Default gateway base — the executions API lives here. */
export const DEFAULT_BASE_URL = "https://api.sapiom.ai";

/** The placeholder rendered in place of a real API key — never a real secret. */
export const API_KEY_PLACEHOLDER = "YOUR_SAPIOM_API_KEY";

export interface GenerateSnippetArgs {
  /** The deployed agent's slug (its stable handle). */
  definition: string;
  /** A best-effort sample input; `undefined`/`null` renders a placeholder. */
  inputSample?: unknown;
  /** Gateway base URL; defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
}

export interface SnippetBundle {
  /** `@sapiom/tools` SDK call. */
  typescript: string;
  /** Raw HTTP via cURL — the universal fallback. */
  curl: string;
}

/** Render the sample as a TypeScript object-literal value, re-indented two
 *  spaces so nested lines sit under `input:`. A comment placeholder (valid TS,
 *  invalid JSON — hence separate from the cURL form) when there's no sample. */
function tsInput(sample: unknown): string {
  if (sample === undefined || sample === null) return "{ /* your input */ }";
  return JSON.stringify(sample, null, 2).replace(/\n/g, "\n  ");
}

/** Render the sample as compact JSON for a single-line shell `-d` body. Empty
 *  object (valid JSON) when there's no sample. */
function curlInput(sample: unknown): string {
  if (sample === undefined || sample === null) return "{}";
  return JSON.stringify(sample);
}

function typescriptSnippet(definition: string, inputSample: unknown): string {
  return `import { agents } from "@sapiom/tools";

const result = await agents.run({
  definition: ${JSON.stringify(definition)},
  input: ${tsInput(inputSample)},
});

if (result.status === "completed") {
  console.log(result.output);
}
`;
}

function curlSnippet(definition: string, inputSample: unknown, baseUrl: string): string {
  return `curl -X POST ${baseUrl}/agents/v1/definitions/${definition}/executions \\
  -H "x-api-key: ${API_KEY_PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -d '{ "input": ${curlInput(inputSample)} }'
`;
}

/**
 * Build the copy-paste trigger snippets (TypeScript SDK + cURL) for a deployed
 * agent. Both call the same executions API; the API key is always a placeholder.
 */
export function generateSnippet(args: GenerateSnippetArgs): SnippetBundle {
  const { definition, inputSample, baseUrl = DEFAULT_BASE_URL } = args;
  return {
    typescript: typescriptSnippet(definition, inputSample),
    curl: curlSnippet(definition, inputSample, baseUrl),
  };
}
