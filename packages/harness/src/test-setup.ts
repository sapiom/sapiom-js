import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Telemetry is live by default: an unconfigured emitter delivers to the real
// production collector. Disable it globally here; tests that assert delivery
// opt back in explicitly via the mock collector (SAPIOM_ANALYTICS_ENDPOINT).
process.env.SAPIOM_TELEMETRY_DISABLED = "1";

// The coding-agent system prompt is fetched from the backend on session start
// (SAP-2810), so every spec that boots the real server would otherwise make a live
// request. Pin the bundled prompt globally here; the fetch itself is covered by
// profiles/system-prompt-fetch.test.ts, which calls it directly.
process.env.SAPIOM_HARNESS_PROMPT_FETCH_DISABLED = "1";

// Launch-time MCP generation reads ~/.sapiom/credentials.json by design. Give
// every test file an isolated home so a developer's real credential and
// current environment can never enter a generated config or affect assertions.
// Tests that intentionally exercise home-directory behavior can still replace
// HOME/USERPROFILE or mock os.homedir() within their own scope.
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const isolatedHome = mkdtempSync(join(tmpdir(), "sapiom-harness-test-home-"));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(isolatedHome, { recursive: true, force: true });
});
