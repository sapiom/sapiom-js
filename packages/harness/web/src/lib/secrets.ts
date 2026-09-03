/**
 * Secrets domain logic, ported from the Studio design
 * (`design-eng/agent-studio-v2/src/lib/secrets.ts`).
 *
 * A secret belongs to ONE AGENT. That is the whole model, and it is the
 * platform's: the engine stores them per definition
 * (`/v1/workflows/definitions/:id/secrets`, names only on read) and the vault
 * keys them by that definition's ref. There is no account tier, no session
 * tier, and no precedence between tiers.
 *
 * An earlier pass of the design ported the webapp's account/workflow/session
 * ladder with narrowest-wins resolution. That ladder is a demo construct
 * (`design-eng/webapp/src/lib/demo/secrets.ts`, an app whose README states it
 * runs on simulated data), and shipping it would have taught engineers a scope
 * model the platform does not have. It is deliberately absent here.
 *
 * WHAT IS NOT HERE, and why: the design's `secretHint` (the redacted
 * `sk-a…3f9x` shown beside a row). The platform's read is names-only, so a
 * hint could only ever be shown for values this machine happens to hold —
 * populated for some rows and blank for others, which is identification you
 * cannot trust. Dropped rather than half-rendered.
 */

/** Uppercase and normalize separators as the user types (the platform stores
 *  names uppercase). */
export function normalizeSecretName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^A-Z0-9_]/g, "")
    .slice(0, 64);
}

/** Returns an error message, or null when the name is valid. */
export function validateSecretName(name: string): string | null {
  // Empty is handled by the disabled submit, never by shouting at someone
  // who has not typed yet.
  if (!name) return null;
  if (/^[0-9]/.test(name)) return "Names cannot start with a number.";
  if (name.startsWith("SAPIOM_")) {
    return "SAPIOM_ is reserved for values Sapiom injects at run time.";
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    return "Use A to Z, 0 to 9, and underscores only.";
  }
  return null;
}

export interface DotEnvParse {
  entries: { name: string; value: string }[];
  /** Offending line snippets, so a skipped line is named rather than lost. */
  invalid: string[];
}

/** Parse pasted .env text: comments and `export ` prefixes tolerated, quotes
 *  stripped, duplicates and invalid names reported rather than swallowed. */
export function parseDotEnv(text: string): DotEnvParse {
  const entries: DotEnvParse["entries"] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  const snippet = (line: string): string =>
    line.length > 40 ? `${line.slice(0, 40)}…` : line;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      invalid.push(snippet(line));
      continue;
    }
    const name = normalizeSecretName(match[1]!);
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value || validateSecretName(name) || seen.has(name)) {
      invalid.push(snippet(line));
      continue;
    }
    seen.add(name);
    entries.push({ name, value });
  }
  return { entries, invalid };
}
