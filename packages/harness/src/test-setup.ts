// Telemetry is live by default: an unconfigured emitter delivers to the real
// production collector. Disable it globally here; tests that assert delivery
// opt back in explicitly via the mock collector (SAPIOM_ANALYTICS_ENDPOINT).
process.env.SAPIOM_TELEMETRY_DISABLED = "1";

// The coding-agent system prompt is fetched from the backend on session start
// (SAP-2810), so every spec that boots the real server would otherwise make a live
// request. Pin the bundled prompt globally here; the fetch itself is covered by
// profiles/system-prompt-fetch.test.ts, which calls it directly.
process.env.SAPIOM_HARNESS_PROMPT_FETCH_DISABLED = "1";
