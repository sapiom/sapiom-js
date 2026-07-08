import type { AnalyticsConfig } from "./types.js";

/**
 * Resolve consent once, at instance creation. Precedence (highest wins):
 *
 * 1. programmatic `disabled: true`
 * 2. `SAPIOM_TELEMETRY_DISABLED=1` (or `true`)
 * 3. `DO_NOT_TRACK=1` (or `true`)
 * 4. injected `consentProvider` (`true`/`false` decides, `undefined` falls through)
 * 5. default: enabled
 */
export function resolveConsent(config: AnalyticsConfig): boolean {
  try {
    if (config.disabled === true) return false;
    if (isEnvFlagSet(process.env.SAPIOM_TELEMETRY_DISABLED)) return false;
    if (isEnvFlagSet(process.env.DO_NOT_TRACK)) return false;
    if (typeof config.consentProvider === "function") {
      try {
        const decision = config.consentProvider();
        if (decision === true) return true;
        if (decision === false) return false;
      } catch {
        // A broken consent provider has no opinion.
      }
    }
    return true;
  } catch {
    // If consent cannot be resolved, stay off: never emit without a
    // positive resolution.
    return false;
  }
}

function isEnvFlagSet(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}
