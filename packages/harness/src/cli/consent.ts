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
 * Resolves the telemetry opt-in state. Prompts once on first run and persists
 * the answer; subsequent runs reuse the stored value silently. `--no-telemetry`
 * always wins and never prompts.
 */
export async function ensureConsent(options: EnsureConsentOptions): Promise<boolean> {
  if (options.noTelemetry) return false;

  const isFirstRun = !(await hasStoredSettings());
  const settings = await loadSettings();

  if (!isFirstRun) return settings.telemetryOptIn;

  const telemetryOptIn = await promptConsent();
  await saveSettings({ ...settings, telemetryOptIn });
  return telemetryOptIn;
}
