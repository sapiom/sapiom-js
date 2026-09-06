import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
      const launch = {
        harnessSessionId: "studio-session",
        cwd: root,
        initialPrompt: "Plan these agents",
      };
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
          if (!received.args.includes("resume"))
            expect(received.args.slice(-2)).toEqual([
              "--",
              launch.initialPrompt,
            ]);
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

  it("retains the managed Claude launcher and restrictions during structured inference", async () => {
    const adapter = new ClaudeCodeAdapter({
      binary: process.execPath,
      binaryArgs: [entry],
      binaryEnv: { ELECTRON_RUN_AS_NODE: "1", DISABLE_AUTOUPDATER: "1" },
    });
    const spec = adapter.launchTask({
      harnessSessionId: "task",
      cwd: root,
      prompt: "Contract evidence",
      structuredInference: {
        projectId: "project-test",
        schema: { type: "object" },
        schemaFile: join(root, "schema.json"),
        systemPrompt: "Return JSON",
      },
    });
    expect(spec.args.slice(0, 3)).toEqual([entry, "-p", "--safe-mode"]);
    expect(spec.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDECODE: null,
    });
    expect(spec.args).toContain("--no-session-persistence");
    expect(spec.args[spec.args.indexOf("--tools") + 1]).toBe("");
    const { stdout } = await promisify(execFile)(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 5_000,
      windowsHide: true,
    });
    expect(JSON.parse(stdout).args).toEqual(spec.args.slice(1));
  });

  it("runs both Codex inference subprocesses through the managed entry while isolating the worker profile", async () => {
    const originalProfile = join(root, "native profile");
    const taskDir = join(root, "task");
    const callsFile = join(root, "calls.jsonl");
    await mkdir(originalProfile);
    await mkdir(taskDir);
    await writeFile(
      join(originalProfile, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "test-only" }),
    );
    await writeFile(
      entry,
      `
const fs = require('node:fs');
const record = (value) => fs.appendFileSync(process.env.MANAGED_TEST_CALLS, JSON.stringify(value) + '\\n');
record({ args: process.argv.slice(2), profile: process.env.CODEX_HOME, managed: process.env.ELECTRON_RUN_AS_NODE });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
require('node:readline').createInterface({input: process.stdin}).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  record({ method: request.method, params: request.params });
  let result = {};
  if (request.method === 'config/read') result = { config: { model: 'native-default', cli_auth_credentials_store: 'file' } };
  if (request.method === 'thread/start') result = { thread: { id: 'thread-test' } };
  if (request.method === 'turn/start') result = { turn: { id: 'turn-test' } };
  send({ id: request.id, result });
  if (request.method === 'turn/start') {
    send({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test', item: { type: 'agentMessage', text: JSON.stringify({nodes: []}) } } });
    send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
  }
});
`,
    );
    const adapter = new CodexAdapter({
      binary: process.execPath,
      binaryArgs: [entry],
      binaryEnv: { ELECTRON_RUN_AS_NODE: "1", MANAGED_TEST_CALLS: callsFile },
    });
    const spec = adapter.launchTask({
      harnessSessionId: "task",
      cwd: taskDir,
      prompt: "Contract evidence",
      structuredInference: {
        projectId: "project-test",
        schema: { type: "object" },
        schemaFile: join(taskDir, "schema.json"),
        systemPrompt: "Return JSON",
      },
    });
    expect(spec.args.slice(1)).toEqual([process.execPath, entry]);
    // Use the source worker under the test loader; packaged smoke exercises its emitted JS.
    const sourceWorker = spec.args[0]!.replace(/\.js$/, ".ts");
    const loader = createRequire(import.meta.url).resolve("tsx/esm");
    const child = execFile(
      spec.command,
      ["--import", loader, sourceWorker, ...spec.args.slice(1)],
      {
        cwd: spec.cwd,
        env: {
          ...process.env,
          CODEX_HOME: originalProfile,
          ...spec.env,
        } as NodeJS.ProcessEnv,
        timeout: 10_000,
        windowsHide: true,
      },
    );
    const output = new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (data: string) => {
        stdout += data;
      });
      child.stderr!.on("data", (data: string) => {
        stderr += data;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve(stdout)
          : reject(new Error(`Inference exited ${code}: ${stderr}`)),
      );
    });
    child.stdin!.end(spec.stdin);
    expect(JSON.parse(await output)).toEqual({
      type: "result",
      is_error: false,
      structured_output: { nodes: [] },
    });
    const calls = (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const starts = calls.filter((call) => call.args);
    expect(starts).toHaveLength(2);
    expect(starts.map((call) => call.profile)).toEqual([
      originalProfile,
      join(taskDir, "codex"),
    ]);
    for (const call of starts) {
      expect(call.managed).toBe("1");
      expect(call.args[0]).toBe("app-server");
      expect(call.args).toContain("features.shell_tool=false");
      expect(call.args).toContain("features.multi_agent=false");
    }
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(
      1,
    );
    expect(
      calls.find((call) => call.method === "thread/start").params,
    ).toMatchObject({
      ephemeral: true,
      approvalPolicy: "never",
      config: { features: { shell_tool: false } },
    });
    expect(await readFile(join(originalProfile, "auth.json"), "utf8")).toBe(
      JSON.stringify({ OPENAI_API_KEY: "test-only" }),
    );
  }, 15_000);
});
