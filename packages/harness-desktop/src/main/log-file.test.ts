/**
 * `log-file.ts` is kept free of an `electron` import (the caller passes the
 * resolved path) precisely so this file can test it — including `initFileLog`
 * end-to-end against a scratch dir. The file log is the ONLY diagnostic channel
 * a packaged Windows (GUI-subsystem) build has, so "the line actually lands in
 * the file" is worth a real-filesystem test, not just the pure helpers.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { LOG_SIZE_LIMIT_BYTES, formatLogLine, initFileLog, shouldRotate } from "./log-file.js";

describe("formatLogLine", () => {
  const now = new Date("2026-08-12T10:20:30.456Z");

  it("emits [ISO timestamp] [level] and util.format's the args", () => {
    expect(formatLogLine("log", ["hello"], now)).toBe("[2026-08-12T10:20:30.456Z] [log] hello\n");
  });

  it("handles multiple args like console.log (printf-style + extras)", () => {
    expect(formatLogLine("warn", ["port %d busy", 8080, { retry: true }], now)).toBe(
      "[2026-08-12T10:20:30.456Z] [warn] port 8080 busy { retry: true }\n",
    );
  });

  it("keeps an Error's stack — the whole point of the harness error tee", () => {
    const err = new Error("boom");
    const line = formatLogLine("error", ["[harness] unhandled request error:", err], now);
    expect(line).toContain("[error] [harness] unhandled request error:");
    expect(line).toContain("Error: boom");
    expect(line).toContain("at "); // stack frames survive util.format
    expect(line.endsWith("\n")).toBe(true);
  });
});

describe("shouldRotate", () => {
  it("rotates only past the 2 MB limit", () => {
    expect(LOG_SIZE_LIMIT_BYTES).toBe(2 * 1024 * 1024);
    expect(shouldRotate(0)).toBe(false);
    expect(shouldRotate(LOG_SIZE_LIMIT_BYTES)).toBe(false);
    expect(shouldRotate(LOG_SIZE_LIMIT_BYTES + 1)).toBe(true);
  });
});

describe("initFileLog (end-to-end, no electron)", () => {
  // initFileLog wraps the global console and is deliberately once-per-process,
  // so this is a single scenario exercising boot rotation, the tee on all three
  // levels, and idempotency together. Originals are restored afterwards to keep
  // vitest's console clean for other test files.
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const dir = mkdtempSync(join(tmpdir(), "sapiom-log-file-"));
  afterAll(() => {
    Object.assign(console, originals);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rotates an oversized log, writes the header, tees all three levels, and is idempotent", async () => {
    // Pre-seed an oversized file to prove boot rotation discards it.
    const logPath = join(dir, "logs", "main.log");
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(logPath, "x".repeat(LOG_SIZE_LIMIT_BYTES + 1));

    initFileLog(logPath, "9.9.9-test");
    initFileLog(logPath, "9.9.9-test"); // idempotent: no double wrap, no second header

    console.log("plain %s", "log");
    console.warn("a warning");
    console.error("an error", new Error("kaput"));

    // The tee goes through a write stream, which flushes asynchronously.
    const content = await vi.waitFor(() => {
      const text = readFileSync(logPath, "utf8");
      expect(text).toContain("kaput");
      return text;
    });

    // Rotation happened: the >2 MB of 'x' padding is gone.
    expect(statSync(logPath).size).toBeLessThan(LOG_SIZE_LIMIT_BYTES);
    expect(content).not.toContain("xxxx");
    // Header: version + platform + arch, exactly once (a double wrap or double
    // init would have written it twice).
    expect(content.match(/9\.9\.9-test/g)).toHaveLength(1);
    expect(content).toContain(`9.9.9-test ${process.platform} ${process.arch}`);
    // All three levels tee'd, each exactly once.
    expect(content.match(/\[log\] plain log/g)).toHaveLength(1);
    expect(content.match(/\[warn\] a warning/g)).toHaveLength(1);
    expect(content.match(/\[error\] an error Error: kaput/g)).toHaveLength(1);
    // Every line carries the ISO-timestamp + level prefix.
    for (const line of content.trimEnd().split("\n")) {
      expect(line).toMatch(/^(\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[(log|warn|error)\] |\s)/);
    }
  });
});
