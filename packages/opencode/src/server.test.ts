import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evaluateTrackedClosure,
  evaluateWindowsCleanup,
  executeHandoff,
  OpenCodeShutdownError,
  OpenCodeStartupError,
  startOpenCodeServer,
  studioPluginSource,
  type OpenCodeServer,
} from "./server.js";
import { createSapiomOpenCodeConfig, deniedAskPermissions } from "./config.js";

/** Actions the config grants each shell tool OpenCode 1.18.29 has. */
const shellActions = (config: Record<string, unknown>) => {
  const permission = (config.permission ?? {}) as Record<string, unknown>;
  return ["bash"].map((tool) => permission[tool] ?? "allow (default)");
};

/** Action on `edit`, the key OpenCode 1.18.29 checks for edit, write and apply_patch. */
const editAction = (config: Record<string, unknown>) =>
  ((config.permission ?? {}) as Record<string, unknown>).edit ??
  "allow (default)";

let directory: string;
let server: OpenCodeServer | undefined;
const command = {
  executable: process.execPath,
  prefixArgs: [
    fileURLToPath(new URL("./__fixtures__/server.mjs", import.meta.url)),
  ],
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "opencode-runtime-"));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(directory, { recursive: true, force: true });
});
const options = (config: Record<string, unknown> = {}) => ({
  command,
  config,
  cwd: directory,
  stateRoot: join(directory, "state"),
});

async function waitForRuntimePid(timeoutMs: number): Promise<number> {
  const pidPath = join(directory, "runtime.pid");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number(await readFile(pidPath, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
      throw new Error("runtime fixture published an invalid PID");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error("runtime fixture did not publish readiness");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("packaged OpenCode runtime", () => {
  it("distinguishes Windows no-child spawn failure from post-spawn exit", () => {
    expect(evaluateWindowsCleanup(undefined, undefined)).toBe("no-child");
    expect(evaluateWindowsCleanup(42, null)).toBe("running");
    expect(evaluateWindowsCleanup(42, 1)).toBe("uncertain");
  });

  it("rejects a zombie before positive descendant fencing", () => {
    const tracked = new Map([
      ["20:birth-20", { pid: 20, birthId: "birth-20" }],
      ["22:birth-22", { pid: 22, birthId: "birth-22" }],
    ]);
    expect(
      evaluateTrackedClosure(
        tracked,
        new Map([
          [20, { pid: 20, birthId: "birth-20", state: "T" }],
          [22, { pid: 22, birthId: "birth-22", state: "S" }],
        ]),
      ),
    ).toBe("waiting");
    expect(
      evaluateTrackedClosure(
        tracked,
        new Map([
          [20, { pid: 20, birthId: "birth-20", state: "Z" }],
          [21, { pid: 21, birthId: "birth-21", state: "S" }],
          [22, { pid: 22, birthId: "birth-22", state: "T" }],
        ]),
      ),
    ).toBe("uncertain");

    expect(
      evaluateTrackedClosure(
        tracked,
        new Map([
          [20, { pid: 20, birthId: "birth-20", state: "T" }],
          [22, { pid: 22, birthId: "birth-22", state: "T" }],
        ]),
      ),
    ).toBe("stopped");
  });

  it("uses the bridge for model and MCP authentication and strips host secrets from tool environments", async () => {
    const config = createSapiomOpenCodeConfig({
      bridgeUrl: "http://127.0.0.1:1234/opencode-runtime/runtime",
      runtimeToken: "scoped-token",
    });
    expect(config.provider).toMatchObject({
      sapiom: {
        npm: "@ai-sdk/openai",
        options: {
          apiKey: "scoped-token",
          baseURL: "http://127.0.0.1:1234/opencode-runtime/runtime/llm/v1",
        },
        models: {
          "gpt-luna": {
            options: {
              store: false,
              include: ["reasoning.encrypted_content"],
              reasoningEffort: "low",
            },
          },
        },
      },
    });
    server = await startOpenCodeServer({
      ...options(config),
      environment: {
        ...process.env,
        SAPIOM_API_KEY: "sk_private",
        ANTHROPIC_API_KEY: "private",
        ESBUILD_BINARY_PATH: "/app.asar/private",
      },
    });
    const inspected = await server.fetchJson<{
      cwd: string;
      keys: string[];
      runtimeKeys: string[];
      credentialValueInherited: boolean;
      configChecks: {
        model: string;
        modelBridge: boolean;
        mcpBridge: boolean;
      };
    }>("/inspect");
    expect(inspected.cwd).toBe(directory);
    expect(inspected.keys).toContain("OPENCODE_EXPERIMENTAL_CODE_MODE");
    expect(inspected.keys).not.toContain("OPENCODE_EXPERIMENTAL");
    for (const key of [
      "SAPIOM_API_KEY",
      "ANTHROPIC_API_KEY",
      "ESBUILD_BINARY_PATH",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_SERVER_USERNAME",
      "OPENCODE_SERVER_PASSWORD",
    ])
      expect([...inspected.keys, ...inspected.runtimeKeys]).not.toContain(key);
    expect(inspected.credentialValueInherited).toBe(false);
    expect(inspected.configChecks).toEqual({
      model: "sapiom/gpt-luna",
      modelBridge: true,
      mcpBridge: true,
    });
    expect(config.agent).toMatchObject({
      "sapiom-final-response": { hidden: true, permission: { "*": "deny" } },
      "sapiom-turn-recovery": { hidden: true, mode: "primary" },
    });
    expect(
      (config.agent as Record<string, unknown>)["sapiom-turn-recovery"],
    ).not.toHaveProperty("permission");
    await expect(server.fetch("https://other.example/private")).rejects.toThrow(
      "Invalid",
    );
    await expect(server.fetch("//other.example/private")).rejects.toThrow(
      "Invalid",
    );
    await expect(server.fetchJson("/missing")).rejects.toThrow(
      "OpenCode request failed",
    );
    const pid = server.pid;
    await Promise.all([server.close(), server.close()]);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("bounds hung startup, cleans up the child, and allows another startup", async () => {
    const starting = startOpenCodeServer({
      ...options({ stall: true }),
      startupTimeoutMs: 5_000,
    });
    const outcomePromise = starting.then(
      () => ({ started: true as const, error: undefined }),
      (error: unknown) => ({ started: false as const, error }),
    );
    let outcome!: Awaited<typeof outcomePromise>;
    let pid!: number;
    try {
      pid = await waitForRuntimePid(4_000);
    } finally {
      outcome = await outcomePromise;
    }
    expect(outcome.started).toBe(false);
    expect(outcome.error).toMatchObject({
      name: "OpenCodeStartupError",
      code: "timed-out",
      retryable: true,
      message: "OpenCode took too long to start. Retry the connection.",
    });
    expect(() => process.kill(pid, 0)).toThrow();
    server = await startOpenCodeServer(options());
    expect(server.pid).not.toBe(pid);
  }, 30_000);

  it("honors revocation during startup and sanitizes child diagnostics", async () => {
    const abort = new AbortController();
    const starting = startOpenCodeServer({
      ...options({ stall: true }),
      signal: abort.signal,
    });
    const timer = setTimeout(() => abort.abort(), 100);
    try {
      await expect(starting).rejects.toMatchObject({
        code: "cancelled",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
    await expect(startOpenCodeServer(options({ crash: true }))).rejects.toEqual(
      new OpenCodeShutdownError(),
    );
  });

  it.skipIf(process.platform !== "linux")(
    "withholds cleanup proof when a startup exit leaves detached work",
    async () => {
      const writerLog = join(directory, "startup-writer.log");
      let cleanupProof: { path: string; token: string } | undefined;
      let writerPid: number | undefined;
      let writerBirthId: string | undefined;
      try {
        await expect(
          startOpenCodeServer({
            ...options({ startupExitWriter: writerLog }),
            beforeLaunch: (identity) => {
              cleanupProof = identity.cleanupProof;
            },
          }),
        ).rejects.toEqual(new OpenCodeShutdownError());

        expect(cleanupProof).toBeDefined();
        await expect(
          readFile(cleanupProof!.path, "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
        writerPid = Number(
          await readFile(join(directory, "runtime.tool.pid"), "utf8"),
        );
        writerBirthId = await linuxBirthId(writerPid);
        expect(writerBirthId).toBeDefined();
        const firstWrites = (await readFile(writerLog, "utf8")).split(
          "\n",
        ).length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const laterWrites = (await readFile(writerLog, "utf8")).split(
          "\n",
        ).length;
        expect(laterWrites).toBeGreaterThan(firstWrites);
      } finally {
        if (
          writerPid !== undefined &&
          (await linuxBirthId(writerPid)) === writerBirthId
        )
          process.kill(writerPid, "SIGKILL");
        if (writerPid !== undefined) await waitUntilStopped(writerPid);
      }
    },
  );

  it("never launches native after an awaited protection barrier is aborted", async () => {
    const abort = new AbortController();
    let releaseBarrier!: () => void;
    let enteredBarrier!: () => void;
    const barrierEntered = new Promise<void>((resolve) => {
      enteredBarrier = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const starting = startOpenCodeServer({
      ...options(),
      signal: abort.signal,
      beforeLaunch: async (identity) => {
        expect(identity.pid).toBeGreaterThan(0);
        expect(identity.cleanupProof.token.length).toBeGreaterThanOrEqual(16);
        enteredBarrier();
        await barrier;
      },
    });
    await barrierEntered;
    abort.abort();
    releaseBarrier();
    await expect(starting).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      readFile(join(directory, "runtime.pid"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sanitizes protection failure and confirms resistant group cleanup", async () => {
    await expect(
      startOpenCodeServer({
        ...options(),
        beforeLaunch: async () => {
          throw new Error("private lock diagnostic");
        },
      }),
    ).rejects.toEqual(new OpenCodeStartupError("launch-failed"));

    const nativeLaunchMarker = join(directory, "native-term-launch");
    const descendantLaunchMarker = join(directory, "descendant-term-launch");
    server = await startOpenCodeServer(
      options({
        resistant: true,
        resistantMarker: descendantLaunchMarker,
        spawnOnTermMarker: nativeLaunchMarker,
      }),
    );
    const nativePid = Number(
      await readFile(join(directory, "runtime.pid"), "utf8"),
    );
    const resistantPid = Number(
      await readFile(join(directory, "runtime.tool.pid"), "utf8"),
    );
    await server.close();
    expect(await processIsRunning(nativePid)).toBe(false);
    expect(await processIsRunning(resistantPid)).toBe(false);
    await expect(readFile(nativeLaunchMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(descendantLaunchMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("classifies real executable path and permission failures without raw details", async () => {
    const missing = join(directory, "private-provider-token-missing");
    await expect(
      startOpenCodeServer({
        ...options(),
        command: { executable: missing },
      }),
    ).rejects.toEqual(new OpenCodeStartupError("executable-not-found"));
    if (process.platform !== "win32") {
      const blocked = join(directory, "private-provider-token-blocked");
      await writeFile(blocked, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      await expect(
        startOpenCodeServer({
          ...options(),
          command: { executable: blocked },
        }),
      ).rejects.toEqual(new OpenCodeStartupError("permission-denied"));
    }
    expect(
      (await readdir(join(directory, "state"))).filter((entry) =>
        entry.startsWith("launch-"),
      ),
    ).toEqual([]);
  });

  it("denies every ask rule only when the caller has no reply path", () => {
    const options = {
      bridgeUrl: "http://127.0.0.1:1234/opencode-runtime/runtime",
      runtimeToken: "token",
    };
    expect(createSapiomOpenCodeConfig(options)).not.toHaveProperty(
      "permission",
    );
    const config = createSapiomOpenCodeConfig({ ...options, neverAsk: true });
    expect(config.permission).toEqual(deniedAskPermissions);
    expect(JSON.stringify(config.permission)).not.toContain('"ask"');
    // OpenCode 1.18.29's default ask rules, each overridden.
    expect(config.permission).toMatchObject({
      doom_loop: "deny",
      external_directory: { "*": "deny" },
      question: "deny",
      read: { "*.env": "deny", "*.env.*": "deny" },
    });
  });

  it("removes the shell only when asked, alongside the ask denials", () => {
    const options = {
      bridgeUrl: "http://127.0.0.1:1234/opencode-runtime/runtime",
      runtimeToken: "token",
    };
    expect(shellActions(createSapiomOpenCodeConfig(options))).toEqual([
      "allow (default)",
    ]);
    const mapChat = createSapiomOpenCodeConfig({
      ...options,
      neverAsk: true,
      noShell: true,
    });
    expect(shellActions(mapChat)).toEqual(["deny"]);
    expect(mapChat.permission).toMatchObject(deniedAskPermissions);
    expect(
      shellActions(createSapiomOpenCodeConfig({ ...options, noShell: true })),
    ).toEqual(["deny"]);
  });

  it("removes the file-editing tools with the shell, and only then (I10)", () => {
    const options = {
      bridgeUrl: "http://127.0.0.1:1234/opencode-runtime/runtime",
      runtimeToken: "token",
    };
    // A Studio session's Assistant keeps OpenCode's default edit rule.
    expect(editAction(createSapiomOpenCodeConfig(options))).toBe(
      "allow (default)",
    );
    expect(
      editAction(createSapiomOpenCodeConfig({ ...options, neverAsk: true })),
    ).toBe("allow (default)");
    const mapChat = createSapiomOpenCodeConfig({
      ...options,
      neverAsk: true,
      noShell: true,
    });
    expect(editAction(mapChat)).toBe("deny");
    // Reading stays: the map chat answers questions about the project.
    expect(mapChat.permission).toMatchObject({
      read: { "*": "allow" },
    });
  });

  it("generates a handoff tool that takes a title and a prompt and rejects empty input", async () => {
    // Vitest only imports modules under the package root.
    const local = await mkdtemp(
      fileURLToPath(new URL("../.plugin-test-", import.meta.url)),
    );
    try {
      const hook = join(local, "hook.mjs");
      const plugin = join(local, "plugin.mjs");
      await writeFile(
        hook,
        "export const createStudioCompletionHooks = () => ({});\n",
      );
      await writeFile(
        plugin,
        studioPluginSource({
          hookUrl: pathToFileURL(hook).href,
          readyPath: join(directory, "ready"),
          toolHomeEnvironment: {},
          handoffTool: true,
        }),
      );
      // A Studio session's Assistant does its own work: no handoff tool.
      const plain = join(local, "plain.mjs");
      await writeFile(
        plain,
        studioPluginSource({
          hookUrl: pathToFileURL(hook).href,
          readyPath: join(directory, "plain-ready"),
          toolHomeEnvironment: {},
        }),
      );
      const plainHooks = await (
        (await import(pathToFileURL(plain).href)) as {
          SapiomCredentialIsolation: (
            input: unknown,
          ) => Promise<Record<string, unknown>>;
        }
      ).SapiomCredentialIsolation({ client: {} });
      expect(plainHooks).not.toHaveProperty("tool");
      const module = (await import(pathToFileURL(plugin).href)) as {
        SapiomCredentialIsolation: (input: unknown) => Promise<{
          tool: Record<
            string,
            {
              args: Record<string, unknown>;
              execute: (args: unknown) => Promise<string>;
            }
          >;
        }>;
      };
      const hooks = await module.SapiomCredentialIsolation({ client: {} });
      const handoff = hooks.tool.handoff!;
      expect(Object.keys(hooks.tool)).toEqual(["handoff"]);
      expect(Object.keys(handoff.args)).toEqual(["title", "prompt"]);
      expect(handoff.args.title).toMatchObject({ type: "string" });
      expect(handoff.args.prompt).toMatchObject({ type: "string" });
      await expect(
        handoff.execute({ title: "Build it", prompt: "Build the agent." }),
      ).resolves.toBe(
        "Offered a session card; nothing has started. Tell the user in one sentence that you offered a session they can start. Do not say a session was created or prepared, and do not start the work here.",
      );
      for (const args of [
        {},
        { title: "", prompt: "Build the agent." },
        { title: "Build it", prompt: "   " },
        { title: "x".repeat(61), prompt: "Build the agent." },
        { title: 1, prompt: "Build the agent." },
      ])
        await expect(handoff.execute(args)).rejects.toThrow("handoff needs");
      expect(() => executeHandoff(undefined)).toThrow("handoff needs");
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  });

  it.each([
    "https://remote.example",
    "http://remote.example",
    "http://user:password@127.0.0.1",
    "http://127.0.0.1/?secret=yes",
  ])("refuses a non-private bridge: %s", (bridgeUrl) => {
    expect(() =>
      createSapiomOpenCodeConfig({ bridgeUrl, runtimeToken: "token" }),
    ).toThrow("private loopback");
  });
});

async function processIsRunning(pid: number): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    } catch (error) {
      if (
        ["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return false;
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function linuxBirthId(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error) {
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return undefined;
    throw error;
  }
}

async function waitUntilStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (await processIsRunning(pid)) {
    if (Date.now() >= deadline) throw new Error("fixture process did not stop");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
