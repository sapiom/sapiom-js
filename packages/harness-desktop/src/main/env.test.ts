/**
 * PATH augmentation is the app's most load-bearing 30 lines: a GUI app inherits
 * no shell PATH, so this is the only reason `which claude` and every PTY spawn
 * resolve at all. It's also where a subtle ordering mistake took the whole app
 * down — the Electron-as-Node shims were prepended, which shadowed the user's
 * real `node` for the agent (`#!/usr/bin/env node`) and destabilized it and
 * every subprocess it spawned. These tests pin the ordering contract.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { augmentProcessPath } from "./env.js";

const AGENT_BIN = "/tmp/userData/npm-global/bin";
const SHIMS = "/tmp/userData/runtime-bin";

let originalPath: string | undefined;
beforeEach(() => {
  originalPath = process.env.PATH;
});
afterEach(() => {
  process.env.PATH = originalPath;
  vi.resetModules();
});

describe("augmentProcessPath", () => {
  it("puts the app-installed agent's bin dir first, so a just-installed claude wins", () => {
    process.env.PATH = "/usr/bin:/bin";
    const result = augmentProcessPath(AGENT_BIN).split(":");
    expect(result[0]).toBe(AGENT_BIN);
  });

  it("puts the Electron-as-Node shims LAST — they must never shadow a real node", () => {
    // The regression this guards: with the shims first, the agent's
    // `#!/usr/bin/env node` resolved to Electron-as-Node and the app became
    // unstable after sign-in. The shims are a fallback for a machine with no
    // Node at all, so every inherited entry outranks them.
    process.env.PATH = "/usr/bin:/home/u/.nvm/versions/node/v22.0.0/bin";
    const entries = augmentProcessPath(AGENT_BIN, SHIMS).split(":");

    expect(entries.at(-1)).toBe(SHIMS);
    expect(entries.indexOf(SHIMS)).toBeGreaterThan(entries.indexOf("/home/u/.nvm/versions/node/v22.0.0/bin"));
    expect(entries.indexOf(SHIMS)).toBeGreaterThan(entries.indexOf("/usr/bin"));
  });

  it("appends nothing when no shim dir is supplied", () => {
    process.env.PATH = "/usr/bin";
    expect(augmentProcessPath(AGENT_BIN).split(":")).not.toContain(SHIMS);
  });

  it("keeps every inherited entry, in its original relative order", () => {
    process.env.PATH = "/first:/second:/third";
    const entries = augmentProcessPath(AGENT_BIN, SHIMS).split(":");
    const inherited = entries.filter((e) => ["/first", "/second", "/third"].includes(e));
    expect(inherited).toEqual(["/first", "/second", "/third"]);
  });

  it("dedupes, keeping the earliest (highest-priority) occurrence", () => {
    // /usr/local/bin is one of our candidates AND commonly already inherited —
    // it must appear once, at the candidate (earlier) position.
    process.env.PATH = "/usr/local/bin:/usr/bin";
    const entries = augmentProcessPath(AGENT_BIN, SHIMS).split(":");
    expect(entries.filter((e) => e === "/usr/local/bin")).toHaveLength(1);
    expect(entries.filter((e) => e === AGENT_BIN)).toHaveLength(1);
    expect(new Set(entries).size).toBe(entries.length);
  });

  it("covers the bin dirs a double-clicked app misses, including Homebrew on Apple Silicon", () => {
    process.env.PATH = "";
    const entries = augmentProcessPath(AGENT_BIN).split(":");
    for (const dir of ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", path.join(os.homedir(), ".local", "bin")]) {
      expect(entries).toContain(dir);
    }
  });

  it("writes the result back to process.env.PATH (node-pty inherits it at spawn)", () => {
    process.env.PATH = "/usr/bin";
    const returned = augmentProcessPath(AGENT_BIN, SHIMS);
    expect(process.env.PATH).toBe(returned);
  });

  it("tolerates an unset PATH — a GUI launch can genuinely have none", () => {
    delete process.env.PATH;
    const entries = augmentProcessPath(AGENT_BIN).split(":");
    expect(entries[0]).toBe(AGENT_BIN);
    expect(entries).not.toContain("");
  });

  it("uses ';' and the Windows npm-prefix layout on win32", async () => {
    // `isWindows` is captured at module load, so the platform has to be swapped
    // before a fresh import.
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      vi.resetModules();
      const { augmentProcessPath: winAugment } = await import("./env.js");
      process.env.PATH = "C:\\Windows\\System32";
      const raw = winAugment("C:\\Users\\u\\AppData\\Roaming\\npm", "C:\\shims");
      const entries = raw.split(";");

      expect(raw).not.toContain(":C:"); // never the POSIX separator
      expect(entries[0]).toBe("C:\\Users\\u\\AppData\\Roaming\\npm");
      expect(entries.at(-1)).toBe("C:\\shims");
      // On Windows npm's global shims land in the prefix ROOT, not <prefix>/bin.
      expect(entries.some((e) => e.endsWith("AppData\\Roaming\\npm"))).toBe(true);
      expect(entries).toContain("C:\\Windows\\System32");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }
  });
});
