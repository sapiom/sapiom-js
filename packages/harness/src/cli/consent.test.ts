import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tmpDir };
});

let nextAnswer = "";
let questionCallCount = 0;
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => {
      questionCallCount++;
      return nextAnswer;
    },
    close: () => {},
  }),
}));

import { ensureConsent } from "./consent.js";
import { hasStoredSettings, loadSettings } from "./settings.js";

describe("ensureConsent", () => {
  const OUTER_ENV_KEYS = ["SAPIOM_TELEMETRY_DISABLED", "DO_NOT_TRACK"] as const;
  const outerSaved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-consent-"));
    questionCallCount = 0;
    // Clear env opt-outs so tests that assert "default to ON" behavior see the
    // unadulterated prompt/default path, not the global test guard.
    for (const key of OUTER_ENV_KEYS) {
      outerSaved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    for (const key of OUTER_ENV_KEYS) {
      if (outerSaved[key] === undefined) delete process.env[key];
      else process.env[key] = outerSaved[key];
    }
  });

  it("--no-telemetry forces false without prompting or persisting", async () => {
    const result = await ensureConsent({ noTelemetry: true });
    expect(result.telemetryOptIn).toBe(false);
    expect(result.source).toBe("env-forced-off");

    const settings = await loadSettings();
    expect(settings.telemetryOptIn).toBe(false);
  });

  it("defaults to ON and persists on first run when stdin is not a TTY", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      const result = await ensureConsent({ noTelemetry: false });
      expect(result.telemetryOptIn).toBe(true);
      expect(result.source).toBe("default-silent");

      const settings = await loadSettings();
      expect(settings.telemetryOptIn).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });

  it("reuses the persisted answer on subsequent runs without re-prompting", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      await ensureConsent({ noTelemetry: false }); // first run persists the default (true)
      const settings = await loadSettings();
      // Overwrite with a non-default value to prove the second call reuses
      // whatever was persisted rather than just returning the default again.
      await fs.writeFile(
        path.join(tmpDir, ".sapiom", "harness", "settings.json"),
        JSON.stringify({ ...settings, telemetryOptIn: false }),
      );

      const result = await ensureConsent({ noTelemetry: false });
      expect(result.telemetryOptIn).toBe(false);
      expect(result.source).toBe("stored-explicit");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });

  it("interactive prompt: a blank answer accepts the default (on)", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    nextAnswer = "";

    try {
      const result = await ensureConsent({ noTelemetry: false });
      expect(result.telemetryOptIn).toBe(true);
      expect(result.source).toBe("prompted");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });

  it("interactive prompt: an explicit 'n' opts out", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    nextAnswer = "n";

    try {
      const result = await ensureConsent({ noTelemetry: false });
      expect(result.telemetryOptIn).toBe(false);
      expect(result.source).toBe("prompted");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });

  it("interactive prompt: an explicit 'y' opts in", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    nextAnswer = "y";

    try {
      const result = await ensureConsent({ noTelemetry: false });
      expect(result.telemetryOptIn).toBe(true);
      expect(result.source).toBe("prompted");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });

  describe("environment opt-out (SAPIOM_TELEMETRY_DISABLED / DO_NOT_TRACK)", () => {
    const ENV_KEYS = ["SAPIOM_TELEMETRY_DISABLED", "DO_NOT_TRACK"] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it.each([
      ["SAPIOM_TELEMETRY_DISABLED", "1"],
      ["SAPIOM_TELEMETRY_DISABLED", "true"],
      ["SAPIOM_TELEMETRY_DISABLED", "TRUE"],
      ["DO_NOT_TRACK", "1"],
      ["DO_NOT_TRACK", "true"],
    ])("%s=%s forces telemetry off without prompting, on a first run", async (envVar, value) => {
      process.env[envVar] = value;

      const result = await ensureConsent({ noTelemetry: false });

      expect(result.telemetryOptIn).toBe(false);
      expect(result.source).toBe("env-forced-off");
      expect(result.envReason).toBe(envVar);
      expect(questionCallCount).toBe(0);
      // Nothing persisted: hasStoredSettings() must still say "no" so a
      // later run without the env var gets a genuine first-run prompt,
      // rather than silently inheriting a fabricated opt-out answer.
      expect(await hasStoredSettings()).toBe(false);
    });

    it("overrides a previously persisted opt-in for this run, without rewriting it", async () => {
      // Establish a stored opt-in from an earlier, env-free run.
      const wasTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      try {
        const firstResult = await ensureConsent({ noTelemetry: false });
        expect(firstResult.telemetryOptIn).toBe(true);
      } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
      }
      expect((await loadSettings()).telemetryOptIn).toBe(true);

      process.env.DO_NOT_TRACK = "1";
      const result = await ensureConsent({ noTelemetry: false });

      expect(result.telemetryOptIn).toBe(false);
      expect(result.source).toBe("env-forced-off");
      expect(questionCallCount).toBe(0);
      // The stored preference is untouched — a run without DO_NOT_TRACK set
      // still honors what the user actually answered.
      expect((await loadSettings()).telemetryOptIn).toBe(true);
    });

    it.each([
      ["SAPIOM_TELEMETRY_DISABLED", "0"],
      ["SAPIOM_TELEMETRY_DISABLED", "no"],
      ["DO_NOT_TRACK", "false"],
      ["DO_NOT_TRACK", ""],
    ])("%s=%s is not treated as an opt-out", async (envVar, value) => {
      process.env[envVar] = value;
      const wasTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

      try {
        const result = await ensureConsent({ noTelemetry: false });
        expect(result.telemetryOptIn).toBe(true);
        // env var present but not an opt-out value → "default-silent" (non-TTY)
        expect(result.source).toBe("default-silent");
      } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
      }
    });

    it("--no-telemetry still wins even without any env var set", async () => {
      const result = await ensureConsent({ noTelemetry: true });
      expect(result.telemetryOptIn).toBe(false);
      expect(result.source).toBe("env-forced-off");
      expect(questionCallCount).toBe(0);
    });
  });
});
