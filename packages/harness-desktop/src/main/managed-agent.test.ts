import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentCommand, type AgentCommand } from "./managed-agent.js";

const execute = promisify(execFile);
const runtime: AgentCommand = {
  binary: process.execPath,
  binaryArgs: ["--no-warnings"],
  binaryEnv: { ELECTRON_RUN_AS_NODE: "1", STUDIO_MANAGED_TEST: "preserved" },
};
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "studio-managed-command-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function install(modules: string, entry: string, source: string): Promise<string> {
  const directory = path.join(root, modules, "@openai/codex");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ bin: { codex: entry } }));
  await writeFile(path.resolve(directory, entry), source);
  return directory;
}

describe("managed provider command resolution", () => {
  it.each(["node_modules", "lib/node_modules"])(
    "clears Electron startup state before a CLI or its children run (%s)",
    async (modules) => {
      await install(modules, "cli.mjs", `
        import {execFileSync} from 'node:child_process';
        const child = JSON.parse(execFileSync(process.execPath, ['-e',
          'console.log(JSON.stringify({flag:process.env.ELECTRON_RUN_AS_NODE??null,retained:process.env.STUDIO_MANAGED_TEST}))'
        ], {encoding:'utf8'}));
        console.log(JSON.stringify({flag:process.env.ELECTRON_RUN_AS_NODE??null,child,args:process.argv.slice(2)}));
      `);
      const command = await resolveAgentCommand(root, "codex", runtime);
      expect(command).not.toBeNull();
      const result = await execute(command!.binary, [...command!.binaryArgs, "--version"], {
        env: { ...process.env, ...command!.binaryEnv },
      });
      expect(JSON.parse(result.stdout)).toEqual({
        flag: null, child: { flag: null, retained: "preserved" }, args: ["--version"],
      });
    },
  );

  it("preserves ordinary Node runtime arguments without adding Electron setup", async () => {
    const directory = await install("lib/node_modules", "cli.cjs", "");
    expect(await resolveAgentCommand(root, "codex", { ...runtime, binaryEnv: {} })).toEqual({
      binary: process.execPath, binaryArgs: ["--no-warnings", path.join(directory, "cli.cjs")], binaryEnv: {},
    });
  });

  it("launches native entries without the interpreter environment", async () => {
    const directory = await install("node_modules", "codex", "native fixture");
    expect(await resolveAgentCommand(root, "codex", runtime)).toEqual({
      binary: path.join(directory, "codex"), binaryArgs: [], binaryEnv: {},
    });
  });

  it("rejects package entries outside the installed package", async () => {
    await install("node_modules", "../escaped.cjs", "");
    expect(await resolveAgentCommand(root, "codex", runtime)).toBeNull();
  });
});
