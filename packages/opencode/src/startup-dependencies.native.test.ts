import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import {
  OpenCodeStartupError,
  startOpenCodeServer,
  type OpenCodeServer,
} from "./server.js";

interface StartupTiming {
  attempt: string;
  beforeLaunchMs?: number;
  healthOkMs?: number;
  configResponseMs?: number;
  readyMs?: number;
  settledMs?: number;
  outcome?: string;
}

it("opens two fresh native sessions within the default deadline without a package registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-startup-dependencies-"));
  const runtimes: OpenCodeServer[] = [];
  const registryRequests: string[] = [];
  const registry = createServer((request) => {
    registryRequests.push(request.url ?? "");
    // A registry outage must not delay opening a new Assistant session.
  });
  await new Promise<void>((resolve) =>
    registry.listen(0, "127.0.0.1", resolve),
  );
  const address = registry.address();
  if (!address || typeof address === "string")
    throw new Error("registry unavailable");
  const starts: number[] = [];
  const timings: StartupTiming[] = [];
  let active: { timing: StartupTiming; startedAt: number } | undefined;
  const nativeFetch = globalThis.fetch;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const current = active;
      const response = await nativeFetch(input, init);
      if (current) {
        const path =
          input instanceof URL
            ? input.pathname
            : new URL(typeof input === "string" ? input : input.url).pathname;
        const elapsed = Math.round(performance.now() - current.startedAt);
        if (path === "/global/health" && response.ok)
          current.timing.healthOkMs ??= elapsed;
        if (path === "/config") current.timing.configResponseMs ??= elapsed;
      }
      return response;
    });
  let cleanup: PromiseSettledResult<void>[] = [];
  try {
    const conversations: string[] = [];
    for (const name of ["first", "second"]) {
      const stateRoot = join(root, name);
      let configDirectory = "";
      const startedAt = performance.now();
      const timing: StartupTiming = { attempt: name };
      timings.push(timing);
      active = { timing, startedAt };
      const runtime = await startOpenCodeServer({
        command: process.env.SAPIOM_OPENCODE_CONTEXT_TEST_BINARY
          ? { executable: process.env.SAPIOM_OPENCODE_CONTEXT_TEST_BINARY }
          : undefined,
        cwd: root,
        stateRoot,
        config: {},
        // Deliberately use the production startup deadline, with a fresh HOME.
        beforeLaunch: async () => {
          const launch = (await readdir(stateRoot)).find((entry) =>
            entry.startsWith("launch-"),
          );
          if (!launch) throw new Error("launch directory missing");
          configDirectory = join(stateRoot, launch, "config", "opencode");
          await mkdir(configDirectory, { recursive: true });
          await writeFile(
            join(configDirectory, ".npmrc"),
            `registry=http://127.0.0.1:${address.port}\n`,
          );
          timing.beforeLaunchMs = Math.round(performance.now() - startedAt);
        },
      })
        .then(
          (runtime) => {
            timing.readyMs = Math.round(performance.now() - startedAt);
            timing.outcome = "ready";
            return runtime;
          },
          (error: unknown) => {
            timing.outcome =
              error instanceof OpenCodeStartupError
                ? error.code
                : "other-error";
            throw error;
          },
        )
        .finally(() => {
          timing.settledMs = Math.round(performance.now() - startedAt);
          active = undefined;
        });
      starts.push(performance.now() - startedAt);
      runtimes.push(runtime);
      // The installer fast path must be backed by the real shipped dependency.
      const plugin = join(
        configDirectory,
        "node_modules",
        "@opencode-ai",
        "plugin",
      );
      expect(
        JSON.parse(await readFile(join(plugin, "package.json"), "utf8")),
      ).toMatchObject({
        name: "@opencode-ai/plugin",
        version: "1.18.29",
      });
      const { tool } = await import(
        pathToFileURL(join(plugin, "dist", "index.js")).href
      );
      expect(tool.schema.string().parse("available offline")).toBe(
        "available offline",
      );
      const session = await runtime.fetchJson<{ id: string }>("/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      conversations.push(session.id);
      expect(await runtimes[0]!.fetchJson("/global/health")).toMatchObject({
        healthy: true,
      });
    }
    expect(conversations).toHaveLength(2);
    expect(new Set(conversations).size).toBe(2);
    expect(registryRequests).toEqual([]);
    expect(starts.every((elapsed) => elapsed < 15_000)).toBe(true);
  } finally {
    fetchSpy.mockRestore();
    // Only bounded phase names/timings: no headers, URLs, config, or native logs.
    // Failed settledMs includes the existing bounded cleanup after the deadline.
    console.info(
      "Native startup timing",
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        deadlineMs: 15_000,
        timings,
      }),
    );
    cleanup = await Promise.allSettled(
      runtimes.map((runtime) => runtime.close()),
    );
    registry.closeAllConnections();
    await new Promise<void>((resolve) => registry.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  for (const result of cleanup)
    if (result.status === "rejected") throw result.reason;
}, 40_000);
