import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";

let root: string;
let entry: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "managed CLI with spaces "));
  entry = join(root, "cli.cjs");
  await writeFile(
    entry,
    `if(process.argv.includes('--version')) console.log('99.0.0'); else console.log(JSON.stringify({args:process.argv.slice(2), home:process.env.CODEX_HOME}));`,
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("host-managed CLI launchers", () => {
  it.each(["claude", "codex"])(
    "uses the supplied runtime and entry for %s doctor, fresh launch and resume",
    async (kind) => {
      const options = {
        binary: process.execPath,
        binaryArgs: [entry],
        binaryEnv: { ELECTRON_RUN_AS_NODE: "1" },
      };
      const adapter =
        kind === "codex"
          ? new CodexAdapter(options)
          : new ClaudeCodeAdapter(options);
      expect((await adapter.doctor())[0].ok).toBe(true);
      const launch = { harnessSessionId: "studio-session", cwd: root };
      for (const spec of [
        adapter.launch(launch),
        adapter.resume("previous-conversation", launch),
      ]) {
        expect(spec.args[0]).toBe(entry);
        expect(spec.env.ELECTRON_RUN_AS_NODE).toBe("1");
        const { stdout } = await promisify(execFile)(spec.command, spec.args, {
          cwd: spec.cwd,
          env: { ...process.env, CODEX_HOME: root, ELECTRON_RUN_AS_NODE: "1" },
          timeout: 5_000,
          windowsHide: true,
        });
        const received = JSON.parse(stdout) as { args: string[]; home: string };
        expect(received.home).toBe(root);
        expect(received.args).toEqual(spec.args.slice(1));
        if (kind === "codex") {
          expect(received.args).toContain("check_for_update_on_startup=false");
          expect(received.args).not.toContain("--model");
        } else expect(spec.env.CLAUDECODE).toBeNull();
      }
    },
  );

  it("also sends Claude headless tasks through the selected CLI", () => {
    const adapter = new ClaudeCodeAdapter({
      binary: process.execPath,
      binaryArgs: [entry],
      binaryEnv: { ELECTRON_RUN_AS_NODE: "1", DISABLE_AUTOUPDATER: "1" },
    });
    const spec = adapter.launchTask({
      harnessSessionId: "task",
      cwd: root,
      prompt: "describe",
    });
    expect(spec.args.slice(0, 3)).toEqual([entry, "-p", "describe"]);
    expect(spec.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDECODE: null,
    });
  });
});
