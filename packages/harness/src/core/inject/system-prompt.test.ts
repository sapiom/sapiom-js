import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateSystemPromptFile } from "./system-prompt.js";
import { DEFAULT_SYSTEM_PROMPT } from "../../profiles/default.js";

describe("generateSystemPromptFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-system-prompt-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes the default profile prompt to a session-scoped file", async () => {
    const filePath = await generateSystemPromptFile("session-abc", { generatedRoot: tmpDir });
    expect(filePath).toBe(path.join(tmpDir, "session-abc", "system-prompt.txt"));

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("writes a custom prompt when one is provided", async () => {
    const filePath = await generateSystemPromptFile("session-abc", {
      generatedRoot: tmpDir,
      prompt: "a custom profile",
    });
    expect(await fs.readFile(filePath, "utf8")).toBe("a custom profile");
  });

  it("isolates sessions into separate files", async () => {
    const a = await generateSystemPromptFile("session-a", { generatedRoot: tmpDir });
    const b = await generateSystemPromptFile("session-b", { generatedRoot: tmpDir });
    expect(path.dirname(a)).not.toBe(path.dirname(b));
  });

  it("is safe to regenerate for the same session (overwrites in place)", async () => {
    const first = await generateSystemPromptFile("session-abc", { generatedRoot: tmpDir, prompt: "v1" });
    const second = await generateSystemPromptFile("session-abc", { generatedRoot: tmpDir, prompt: "v2" });
    expect(second).toBe(first);
    expect(await fs.readFile(second, "utf8")).toBe("v2");
  });
});
