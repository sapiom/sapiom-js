// Telemetry is live by default: an unconfigured emitter delivers to the real
// production collector. Disable it globally here; tests that assert delivery
// opt back in explicitly via the mock collector (SAPIOM_ANALYTICS_ENDPOINT).
process.env.SAPIOM_TELEMETRY_DISABLED = "1";
