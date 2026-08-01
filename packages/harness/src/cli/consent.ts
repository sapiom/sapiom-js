import * as readline from "node:readline/promises";
import { hasStoredSettings, loadSettings, saveSettings } from "./settings.js";

// Opt-OUT by default (SAP-1988): this gates the *invasive* Sapiom→BigQuery
// telemetry (prompt text + tool calls + session detail). Silently shipping
// that from a tool running on someone's desktop is a reputation risk, so the
// conservative default is off — users who never see a TTY (CI, Docker,
// headless) are never silently opted in, and interactive users are asked with
// a benefit-framed prompt. (Light, non-content PostHog product analytics is a
// separate, on-by-default tier — see HarnessSettings.productAnalyticsOptIn.)
// The first-run UI opt-in lives in web/src/components/WelcomePanel.tsx.
const DEFAULT_TELEMETRY_OPT_IN = false;

const CONSENT_COPY = `
Help us optimize your Studio experience.

With your permission, Sapiom Studio shares your session details — the prompts
you send, the tool calls your agent makes, and session lifecycle events — so we
can see where the product gets in your way and improve it for you.

This is always written locally to ~/.sapiom/harness/events.ndjson for your own
inspection, whether or not you opt in. Sharing with Sapiom is OFF by default;
turn it on anytime in the app's settings gear (or keep it off with
--no-telemetry / SAPIOM_TELEMETRY_DISABLED=1).
`.trim();

async function promptConsent(): Promise<boolean> {
  console.log(`\n${CONSENT_COPY}\n`);

  if (!process.stdin.isTTY) {
    // The full consent copy (what's collected, local store, and opt-out path)
    // was already printed above. Make the default explicit so non-TTY users
    // reviewing logs see it clearly.
    console.log(
      `Non-interactive session — telemetry is defaulting to ${DEFAULT_TELEMETRY_OPT_IN ? "on" : "off"}` +
      ` per the notice above. Run with --no-telemetry or set SAPIOM_TELEMETRY_DISABLED=1 to opt out.\n`,
    );
    return DEFAULT_TELEMETRY_OPT_IN;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Share session details with Sapiom? [y/N] ")).trim().toLowerCase();
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
 * How the telemetry consent state was determined for this boot.
 * Exposed to the server so the UI can show a first-run notice when
 * consent was implicitly set by the non-TTY default rather than explicitly
 * answered by the user.
 */
export type ConsentSource =
  /** `--no-telemetry` flag or SAPIOM_TELEMETRY_DISABLED/DO_NOT_TRACK env var. */
  | "env-forced-off"
  /** Stored consent from a previous first-run prompt — user answered explicitly. */
  | "stored-explicit"
  /** User answered the Y/n prompt just now (interactive TTY). */
  | "prompted"
  /** Non-TTY first run: the silent default was applied and persisted. */
  | "default-silent";

export interface ConsentResult {
  telemetryOptIn: boolean;
  /**
   * Which env var (if any) is forcing telemetry off this run.
   * Only set when source === "env-forced-off".
   */
  envReason: string | null;
  source: ConsentSource;
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
 *
 * Returns a ConsentResult that includes the source of the decision — the UI
 * uses this to show a first-run notice when the user never explicitly answered
 * (source === "default-silent"), skipping it when they did.
 */
export async function ensureConsent(options: EnsureConsentOptions): Promise<ConsentResult> {
  if (options.noTelemetry) {
    return { telemetryOptIn: false, envReason: null, source: "env-forced-off" };
  }

  const envReason = envDisableReason();
  if (envReason) {
    console.log(`Telemetry disabled via ${envReason} — skipping the consent prompt.\n`);
    return { telemetryOptIn: false, envReason, source: "env-forced-off" };
  }

  const isFirstRun = !(await hasStoredSettings());
  const settings = await loadSettings();

  if (!isFirstRun) {
    return { telemetryOptIn: settings.telemetryOptIn, envReason: null, source: "stored-explicit" };
  }

  // First run: prompt the user (TTY) or apply the silent default (non-TTY).
  const isTTY = process.stdin.isTTY;
  const telemetryOptIn = await promptConsent();
  await saveSettings({ ...settings, telemetryOptIn });
  const source: ConsentSource = isTTY ? "prompted" : "default-silent";
  return { telemetryOptIn, envReason: null, source };
}
