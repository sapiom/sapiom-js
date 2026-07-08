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
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => nextAnswer,
    close: () => {},
  }),
}));

import { ensureConsent } from "./consent.js";
import { loadSettings } from "./settings.js";

describe("ensureConsent", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-consent-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("--no-telemetry forces false without prompting or persisting", async () => {
    const optIn = await ensureConsent({ noTelemetry: true });
    expect(optIn).toBe(false);

    const settings = await loadSettings();
    expect(settings.telemetryOptIn).toBe(false);
  });

  it("defaults to ON and persists on first run when stdin is not a TTY", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      const optIn = await ensureConsent({ noTelemetry: false });
      expect(optIn).toBe(true);

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

      const optIn = await ensureConsent({ noTelemetry: false });
      expect(optIn).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });

  it("interactive prompt: a blank answer accepts the default (on)", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    nextAnswer = "";

    try {
      expect(await ensureConsent({ noTelemetry: false })).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });

  it("interactive prompt: an explicit 'n' opts out", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    nextAnswer = "n";

    try {
      expect(await ensureConsent({ noTelemetry: false })).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });

  it("interactive prompt: an explicit 'y' opts in", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    nextAnswer = "y";

    try {
      expect(await ensureConsent({ noTelemetry: false })).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });
});
