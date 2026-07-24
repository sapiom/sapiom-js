/**
 * generateSnippet — pure builder for the "trigger from your code" snippets shown
 * for a deployed agent (the Ship-area snippet panel). No I/O, no React — just
 * strings — so it is unit-testable in isolation.
 *
 * Both snippets are two doorways to the SAME endpoint: the SDK's
 * `agents.run({ definition, input })` and the raw cURL below both POST to
 * `{base}/agents/v1/definitions/{definition}/executions` with the tenant
 * credential in `x-sapiom-api-key` — verified against `@sapiom/tools`' own
 * `agents.launch` (the base defaults to {@link DEFAULT_BASE_URL} and is
 * overridable via `SAPIOM_AGENTS_URL` / `SAPIOM_TOOLS_BASE`). The key is ALWAYS
 * the literal placeholder `YOUR_SAPIOM_API_KEY`, never a real key.
 */

/** Default base for the executions endpoint — matches `@sapiom/tools`' own
 *  default, so the cURL and the SDK snippet hit the same host. */
export const DEFAULT_BASE_URL = "https://tools.sapiom.ai";

/** Header carrying the tenant credential — the SDK transport's default. */
export const AUTH_HEADER = "x-sapiom-api-key";

/** The placeholder rendered in place of a real API key — never a real secret. */
export const API_KEY_PLACEHOLDER = "YOUR_SAPIOM_API_KEY";

export interface GenerateSnippetArgs {
  /** The deployed agent's slug (its stable handle). */
  definition: string;
  /** A best-effort sample input; `undefined`/`null` renders a placeholder. */
  inputSample?: unknown;
  /** Base URL; defaults to {@link DEFAULT_BASE_URL}. */
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

/** POSIX-escape a value for inclusion inside single quotes: every `'` becomes
 *  `'\''` (close, escaped-quote, reopen). Without this, an apostrophe in a
 *  string input value (e.g. `"O'Brien"`) would terminate the `-d '…'` argument
 *  and silently corrupt the request body. */
function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
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
  const body = shellSingleQuote(`{ "input": ${curlInput(inputSample)} }`);
  return `curl -X POST ${baseUrl}/agents/v1/definitions/${definition}/executions \\
  -H "${AUTH_HEADER}: ${API_KEY_PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -d '${body}'
`;
}

/**
 * Build the copy-paste trigger snippets (TypeScript SDK + cURL) for a deployed
 * agent. Both call the same executions endpoint; the API key is always a
 * placeholder.
 */
export function generateSnippet(args: GenerateSnippetArgs): SnippetBundle {
  const { definition, inputSample, baseUrl = DEFAULT_BASE_URL } = args;
  return {
    typescript: typescriptSnippet(definition, inputSample),
    curl: curlSnippet(definition, inputSample, baseUrl),
  };
}
