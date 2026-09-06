import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cliVersion,
  ensureAgentUpdates,
  isNewerStable,
  type AgentUpdateOptions,
} from "./agent-updates.js";
import {
  AGENT_PACKAGES,
  resolveAgentCommand,
  type AgentCommand,
  type AgentKind,
} from "./managed-agent.js";
import { runUpdateCommand } from "./agent-update-process.js";

const runtime: AgentCommand = {
  binary: process.execPath,
  binaryArgs: [],
  binaryEnv: {},
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "studio-agent-updates-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fakeInstall(
  spec: string,
  prefix: string,
  windows = false,
): Promise<boolean> {
  const separator = spec.lastIndexOf("@");
  const pkg = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  const kind = (Object.keys(AGENT_PACKAGES) as AgentKind[]).find(
    (k) => AGENT_PACKAGES[k].package === pkg,
  )!;
  const packageDir = path.join(
    prefix,
    ...(windows ? [] : ["lib"]),
    "node_modules",
    pkg,
  );
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ bin: { [AGENT_PACKAGES[kind].binary]: "cli.cjs" } }),
  );
  await writeFile(
    path.join(packageDir, "cli.cjs"),
    `console.log(${JSON.stringify(version)});`,
  );
  return true;
}

function setup(
  external: Partial<Record<string, string>> = { codex: "codex-cli 0.100.0" },
): AgentUpdateOptions {
  return {
    root,
    runtime,
    enabled: true,
    latest: vi.fn(async () => "0.134.0"),
    install: vi.fn((spec, prefix) => fakeInstall(spec, prefix)),
    probe: vi.fn(async (command) => {
      if (!command.binaryArgs.length && !path.isAbsolute(command.binary))
        return external[command.binary] ?? null;
      const result = await runUpdateCommand(
        command.binary,
        [...command.binaryArgs, "--version"],
        {
          env: { ...process.env, ...command.binaryEnv },
          timeoutMs: 2_000,
        },
      );
      return result.ok ? result.stdout.trim() : null;
    }),
  };
}

describe("startup CLI updates", () => {
  it("adopts an updated Studio-owned Codex when the user's PATH CLI is old", async () => {
    const options = setup();
    const result = await ensureAgentUpdates(options);
    expect(options.install).toHaveBeenCalledWith(
      "@openai/codex@0.134.0",
      expect.stringMatching(/0\.134\.0-/),
      expect.any(Function),
    );
    expect(result.codex?.version).toBe("0.134.0");
    expect(await options.probe(result.codex!.command)).toBe("0.134.0");
    expect(result["claude-code"]).toBeUndefined();
    expect(
      JSON.parse(
        await readFile(path.join(root, "codex", "active.json"), "utf8"),
      ).version,
    ).toBe("0.134.0");
  });

  it("updates both agents, including old Claude when Codex is already available", async () => {
    const options = setup({
      claude: "2.1.0 (Claude Code)",
      codex: "codex-cli 0.100.0",
    });
    options.latest = vi.fn(async (kind) =>
      kind === "claude-code" ? "2.1.90" : "0.134.0",
    );
    const result = await ensureAgentUpdates(options);
    expect(result["claude-code"]?.version).toBe("2.1.90");
    expect(result["claude-code"]?.command.binaryEnv.DISABLE_AUTOUPDATER).toBe(
      "1",
    );
    expect(result.codex?.version).toBe("0.134.0");
  });

  it.each(["0.134.0", "0.135.0", "0.135.0-beta.1"])(
    "keeps a current/newer external Codex (%s)",
    async (version) => {
      const options = setup({ codex: `codex-cli ${version}` });
      expect(await ensureAgentUpdates(options)).toEqual({});
      expect(options.install).not.toHaveBeenCalled();
    },
  );

  it("keeps an unparseable user version instead of assuming a downgrade is an update", async () => {
    const options = setup({ codex: "custom build" });
    await ensureAgentUpdates(options);
    expect(options.latest).not.toHaveBeenCalled();
    expect(options.install).not.toHaveBeenCalled();
  });

  it("reuses a verified managed CLI offline without reinstalling", async () => {
    const options = setup();
    const initial = await ensureAgentUpdates(options);
    const pointer = await readFile(
      path.join(root, "codex", "active.json"),
      "utf8",
    );
    options.latest = vi.fn(async () => {
      throw new Error("offline");
    });
    options.install = vi.fn();
    expect(await ensureAgentUpdates(options)).toEqual(initial);
    expect(options.install).not.toHaveBeenCalled();
    expect(
      await readFile(path.join(root, "codex", "active.json"), "utf8"),
    ).toBe(pointer);
  });

  it.each(["failure", "wrong-version", "missing-entry"])(
    "retains the working executable and selector after %s",
    async (failure) => {
      const options = setup();
      const initial = await ensureAgentUpdates(options);
      const pointer = await readFile(
        path.join(root, "codex", "active.json"),
        "utf8",
      );
      options.latest = async () => "0.135.0";
      options.install = async (_spec, prefix) => {
        if (failure === "wrong-version")
          return fakeInstall("@openai/codex@0.1.0", prefix);
        await writeFile(path.join(prefix, "partial-download"), "interrupted");
        return failure !== "failure";
      };
      expect(await ensureAgentUpdates(options)).toEqual(initial);
      expect(await options.probe(initial.codex!.command)).toBe("0.134.0");
      expect(
        await readFile(path.join(root, "codex", "active.json"), "utf8"),
      ).toBe(pointer);
    },
  );

  it("does not replace a newer external beta with an older selected managed version", async () => {
    await ensureAgentUpdates(setup());
    const options = setup({ codex: "codex-cli 0.140.0-beta.1" });
    expect(await ensureAgentUpdates(options)).toEqual({});
    expect(options.install).not.toHaveBeenCalled();
  });

  it("does not activate an installation that finishes after Studio starts quitting", async () => {
    const options = setup();
    const initial = await ensureAgentUpdates(options);
    const pointer = await readFile(
      path.join(root, "codex", "active.json"),
      "utf8",
    );
    const controller = new AbortController();
    options.signal = controller.signal;
    options.latest = async () => "0.135.0";
    options.install = async (spec, prefix) => {
      await fakeInstall(spec, prefix);
      controller.abort();
      return true;
    };
    expect(await ensureAgentUpdates(options)).toEqual(initial);
    expect(
      await readFile(path.join(root, "codex", "active.json"), "utf8"),
    ).toBe(pointer);
  });

  it("reuses selected binaries in dev/smoke without registry or install calls", async () => {
    const initial = await ensureAgentUpdates(setup());
    const options = { ...setup(), enabled: false };
    expect(await ensureAgentUpdates(options)).toEqual(initial);
    expect(options.latest).not.toHaveBeenCalled();
    expect(options.install).not.toHaveBeenCalled();
  });

  it("retains older prefixes when selecting a new version, for processes still using them", async () => {
    const options = setup();
    const initial = await ensureAgentUpdates(options);
    options.latest = async () => "0.135.0";
    const updated = await ensureAgentUpdates(options);
    expect(updated.codex?.prefix).not.toBe(initial.codex?.prefix);
    expect(await options.probe(initial.codex!.command)).toBe("0.134.0");
    expect(await options.probe(updated.codex!.command)).toBe("0.135.0");
  });

  it("ignores interrupted unpublished installations", async () => {
    const prefix = path.join(
      root,
      "codex",
      "0.134.0-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    await fakeInstall("@openai/codex@0.134.0", prefix);
    const options = setup();
    const selected = await ensureAgentUpdates(options);
    expect(options.install).toHaveBeenCalledOnce();
    expect(selected.codex?.prefix).not.toBe(prefix);
    expect(await readdir(prefix)).toContain("lib");
  });

  it("rejects a selector pointing outside the managed directory", async () => {
    await mkdir(path.join(root, "codex"));
    await writeFile(
      path.join(root, "codex", "active.json"),
      JSON.stringify({ version: "0.134.0", directory: "../../elsewhere" }),
    );
    const options = { ...setup(), enabled: false };
    expect(await ensureAgentUpdates(options)).toEqual({});
  });

  it("launches an npm JS entry through the supplied runtime on the Windows layout", async () => {
    const prefix = path.join(root, "Windows prefix with spaces");
    await fakeInstall("@openai/codex@0.134.0", prefix, true);
    const command = await resolveAgentCommand(prefix, "codex", {
      ...runtime,
      binaryEnv: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(command?.binary).toBe(process.execPath);
    expect(command?.binaryArgs).toEqual([
      path.join(prefix, "node_modules", "@openai", "codex", "cli.cjs"),
    ]);
    expect(command?.binaryEnv.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(await setup().probe(command!)).toBe("0.134.0");
  });
});

describe("CLI versions", () => {
  it("recognizes provider version output and stable promotion", () => {
    expect(cliVersion("codex-cli 0.134.0")).toBe("0.134.0");
    expect(cliVersion("2.1.90 (Claude Code)")).toBe("2.1.90");
    expect(isNewerStable("0.134.0", "0.134.0-beta.1")).toBe(true);
    expect(isNewerStable("0.134.0", "0.135.0-beta.1")).toBe(false);
    expect(isNewerStable("not-a-version", "0.1.0")).toBe(false);
  });
});
