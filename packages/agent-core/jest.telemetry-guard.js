// Telemetry defaults live after the ship-dark flip; tests must opt in explicitly
// via the mock collector (SAPIOM_ANALYTICS_ENDPOINT). This guard ensures no
// test suite can accidentally emit to the real production collector.
process.env.SAPIOM_TELEMETRY_DISABLED = "1";
