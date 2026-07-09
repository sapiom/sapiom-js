import * as readline from "node:readline/promises";
import { hasStoredSettings, loadSettings, saveSettings } from "./settings.js";

// Internal/friendlies phase: default to opted in (matches the on-by-default
// prompt below and the non-TTY fallback) — flip this the other way for a
// wider release.
const DEFAULT_TELEMETRY_OPT_IN = true;

const CONSENT_COPY = `
Sapiom Harness collects local usage analytics to improve the product:
  - the prompts you send and the tool calls your agent makes
  - session start/stop lifecycle events
This is always written locally to ~/.sapiom/harness/events.ndjson for your
own inspection.

Telemetry is ON to help us improve (opt out anytime in the app's settings
gear, or run with --no-telemetry).
`.trim();

async function promptConsent(): Promise<boolean> {
  console.log(`\n${CONSENT_COPY}\n`);

  if (!process.stdin.isTTY) {
    console.log(`Non-interactive session — defaulting telemetry to ${DEFAULT_TELEMETRY_OPT_IN ? "on" : "off"}.\n`);
    return DEFAULT_TELEMETRY_OPT_IN;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Keep it on? [Y/n] ")).trim().toLowerCase();
    if (answer === "") return DEFAULT_TELEMETRY_OPT_IN;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export interface EnsureConsentOptions {
  /** The `--no-telemetry` flag — forces telemetry off without prompting. */
  noTelemetry: boolean;
}

/**
 * Environment opt-out, same precedence and value-parsing as
 * `@sapiom/analytics-core`'s `resolveConsent()`: `SAPIOM_TELEMETRY_DISABLED`
 * (Sapiom-specific) before `DO_NOT_TRACK` (the ecosystem-wide convention),
 * both accepting `1`/`true` case-insensitively. Checked ahead of any stored
 * settings — an operator setting either at the OS/shell level always wins
 * for that run, regardless of a previously persisted opt-in.
 */
function isEnvFlagSet(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/** Which env var (if any) forces telemetry off this run, for the printed reason. */
function envDisableReason(): string | null {
  if (isEnvFlagSet(process.env.SAPIOM_TELEMETRY_DISABLED)) return "SAPIOM_TELEMETRY_DISABLED";
  if (isEnvFlagSet(process.env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  return null;
}

/**
 * Resolves the telemetry opt-in state. Prompts once on first run and persists
 * the answer; subsequent runs reuse the stored value silently. `--no-telemetry`
 * always wins and never prompts. `SAPIOM_TELEMETRY_DISABLED`/`DO_NOT_TRACK`
 * force telemetry off for this run — overriding a persisted opt-in and
 * skipping the prompt entirely — without touching what's actually stored, so
 * a later run without the env var set sees whatever the user answered (or
 * will still be asked, if this env-vetoed run was their first).
 */
export async function ensureConsent(options: EnsureConsentOptions): Promise<boolean> {
  if (options.noTelemetry) return false;

  const envReason = envDisableReason();
  if (envReason) {
    console.log(`Telemetry disabled via ${envReason} — skipping the consent prompt.\n`);
    return false;
  }

  const isFirstRun = !(await hasStoredSettings());
  const settings = await loadSettings();

  if (!isFirstRun) return settings.telemetryOptIn;

  const telemetryOptIn = await promptConsent();
  await saveSettings({ ...settings, telemetryOptIn });
  return telemetryOptIn;
}
