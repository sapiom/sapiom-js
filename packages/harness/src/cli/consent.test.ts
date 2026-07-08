import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tmpDir };
});

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

  it("defaults to off and persists on first run when stdin is not a TTY", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      const optIn = await ensureConsent({ noTelemetry: false });
      expect(optIn).toBe(false);

      const settings = await loadSettings();
      expect(settings.telemetryOptIn).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });

  it("reuses the persisted answer on subsequent runs without re-prompting", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      await ensureConsent({ noTelemetry: false }); // first run persists false
      const settings = await loadSettings();
      await fs.writeFile(
        path.join(tmpDir, ".sapiom", "harness", "settings.json"),
        JSON.stringify({ ...settings, telemetryOptIn: true }),
      );

      const optIn = await ensureConsent({ noTelemetry: false });
      expect(optIn).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });
});
