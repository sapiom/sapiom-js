/** Production tools host every agents/models/connectors capability resolves to by default. */
const DEFAULT_TOOLS_BASE = "https://tools.sapiom.ai";

/**
 * Resolve the tools gateway base URL: the first per-capability override that is
 * set (e.g. `SAPIOM_AGENTS_URL`), else `SAPIOM_TOOLS_BASE`, else production.
 *
 * Trailing slashes are trimmed because every caller appends `/<route>`; an
 * untrimmed `https://tools.example/` yields `//connectors/v1/...`, which a
 * gateway that matches routes literally rejects.
 */
export function resolveToolsBaseUrl(
  ...overrides: Array<string | undefined>
): string {
  const base =
    overrides.find((o) => o !== undefined) ??
    process.env.SAPIOM_TOOLS_BASE ??
    DEFAULT_TOOLS_BASE;
  return base.replace(/\/+$/, "");
}
