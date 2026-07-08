import * as readline from "node:readline/promises";
import { hasStoredSettings, loadSettings, saveSettings } from "./settings.js";

const CONSENT_COPY = `
Sapiom Harness collects local usage analytics to improve the product:
  - the prompts you send and the tool calls your agent makes
  - session start/stop lifecycle events
This is always written locally to ~/.sapiom/harness/events.ndjson for your
own inspection. With your consent, it's also sent to Sapiom — a free-credits
program for opted-in users is coming soon.

You can change this any time: pass --no-telemetry, or edit
~/.sapiom/harness/settings.json.
`.trim();

async function promptConsent(): Promise<boolean> {
  console.log(`\n${CONSENT_COPY}\n`);

  if (!process.stdin.isTTY) {
    console.log("Non-interactive session — defaulting telemetry to off.\n");
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Enable analytics? [y/N] ")).trim().toLowerCase();
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
