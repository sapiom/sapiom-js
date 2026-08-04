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

  it("describes detailed telemetry as coding-agent activity", async () => {
    const wasTTY = process.stdin.isTTY;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    try {
      await ensureConsent({ noTelemetry: false });
      const printed = log.mock.calls.flat().join("\n");
      expect(printed).toContain("the tool calls your coding agent makes");
      expect(printed).not.toContain("the tool calls your agent makes");
    } finally {
      log.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", {
        value: wasTTY,
        configurable: true,
      });
    }
  });

  it("uses an isolated settings file and names its actual event log", async () => {
    const wasTTY = process.stdin.isTTY;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    const stateRoot = path.join(tmpDir, "throwaway-state");
    const settingsPath = path.join(stateRoot, "settings.json");
    const eventsPath = path.join(stateRoot, "events.ndjson");

    try {
      const result = await ensureConsent({
        noTelemetry: false,
        settingsPath,
        eventsPath,
      });

      expect(result.source).toBe("default-silent");
      expect(await hasStoredSettings(settingsPath)).toBe(true);
      expect(await hasStoredSettings()).toBe(false);
      expect((await loadSettings(settingsPath)).telemetryOptIn).toBe(false);
      const printed = log.mock.calls.flat().join("\n");
      expect(printed).toContain(eventsPath);
      expect(printed).not.toContain("~/.sapiom/harness/events.ndjson");
    } finally {
      log.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", {
        value: wasTTY,
        configurable: true,
      });
    }
  });

  it("defaults to OFF (opt-out) and persists on first run when stdin is not a TTY", async () => {
    // SAP-1988: the invasive Sapiom→BQ tier is opt-out by default — a non-TTY
    // first run (CI/Docker/headless) must never silently opt the user in.
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    try {
      const result = await ensureConsent({ noTelemetry: false });
      expect(result.telemetryOptIn).toBe(false);
      expect(result.source).toBe("default-silent");

      const settings = await loadSettings();
      expect(settings.telemetryOptIn).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: wasTTY,
        configurable: true,
      });
    }
  });

  it("reuses the persisted answer on subsequent runs without re-prompting", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    try {
      await ensureConsent({ noTelemetry: false }); // first run persists the default (false)
      const settings = await loadSettings();
      // Overwrite with a non-default value to prove the second call reuses
      // whatever was persisted rather than just returning the default again.
      await fs.writeFile(
        path.join(tmpDir, ".sapiom", "harness", "settings.json"),
        JSON.stringify({ ...settings, telemetryOptIn: true }),
      );

      const result = await ensureConsent({ noTelemetry: false });
      expect(result.telemetryOptIn).toBe(true);
      expect(result.source).toBe("stored-explicit");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: wasTTY,
        configurable: true,
      });
    }
  });

  it("interactive prompt: a blank answer accepts the default (off)", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    nextAnswer = "";

    try {
      const result = await ensureConsent({ noTelemetry: false });
      expect(result.telemetryOptIn).toBe(false);
      expect(result.source).toBe("prompted");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: wasTTY,
        configurable: true,
      });
    }
  });

  it("interactive prompt: an explicit 'n' opts out", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    nextAnswer = "n";

    try {
      const result = await ensureConsent({ noTelemetry: false });
      expect(result.telemetryOptIn).toBe(false);
      expect(result.source).toBe("prompted");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: wasTTY,
        configurable: true,
      });
    }
  });

  it("interactive prompt: an explicit 'y' opts in", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    nextAnswer = "y";

    try {
      const result = await ensureConsent({ noTelemetry: false });
      expect(result.telemetryOptIn).toBe(true);
      expect(result.source).toBe("prompted");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: wasTTY,
        configurable: true,
      });
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
    ])(
      "%s=%s forces telemetry off without prompting, on a first run",
      async (envVar, value) => {
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
      },
    );

    it("overrides a previously persisted opt-in for this run, without rewriting it", async () => {
      // Establish a stored opt-in from an earlier, env-free run — an explicit
      // 'y' at the prompt (the default is now off, so blank would not opt in).
      const wasTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      nextAnswer = "y";
      try {
        const firstResult = await ensureConsent({ noTelemetry: false });
        expect(firstResult.telemetryOptIn).toBe(true);
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: wasTTY,
          configurable: true,
        });
      }
      expect((await loadSettings()).telemetryOptIn).toBe(true);

      // Reset the prompt counter so the assertion below measures only the
      // env-forced run (the setup above prompted once to store the opt-in).
      questionCallCount = 0;
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
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });

      try {
        const result = await ensureConsent({ noTelemetry: false });
        // The env value is not a valid opt-out flag, so it does NOT force
        // telemetry off via the env path — consent falls through to the normal
        // first-run flow (default-silent, envReason null). The value itself is
        // now the opt-out default, but the point of this test is that the env
        // var was ignored, which source/envReason prove.
        expect(result.source).toBe("default-silent");
        expect(result.envReason).toBeNull();
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: wasTTY,
          configurable: true,
        });
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
