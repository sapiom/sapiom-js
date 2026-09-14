import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpenCodeShutdownError,
  startOpenCodeServer,
  type OpenCodeProcessIdentity,
  type OpenCodeServer,
} from "./server.js";
import { resolveRuntimeCommand } from "./runtime-identity.js";

vi.mock("./runtime-identity.js", async (original) => {
  const actual = await original<typeof import("./runtime-identity.js")>();
  return {
    ...actual,
    resolveRuntimeCommand: vi.fn(actual.resolveRuntimeCommand),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const originalFs = await vi.importActual<typeof fs>("node:fs/promises");
const command = {
  executable: process.execPath,
  prefixArgs: [
    fileURLToPath(new URL("./__fixtures__/server.mjs", import.meta.url)),
  ],
};
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let directory: string;
let active: OpenCodeServer | undefined;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "runtime-cancellation-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await active?.close();
  active = undefined;
  await fs.rm(directory, { recursive: true, force: true });
});
const options = () => ({
  cwd: directory,
  stateRoot: join(directory, "state"),
  config: {},
});
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );

it.each(["abort", "timeout"])(
  "settles %s while read-only command verification is pending, with no late launch",
  async (reason) => {
    const verification = deferred<typeof command>(),
      entered = deferred();
    vi.mocked(resolveRuntimeCommand).mockImplementationOnce(() => {
      entered.resolve();
      return verification.promise;
    });
    const abort = new AbortController();
    let result: Awaited<ReturnType<typeof outcome>> | undefined;
    const pending = outcome(
      startOpenCodeServer({
        ...options(),
        signal: abort.signal,
        startupTimeoutMs: reason === "timeout" ? 30 : 5000,
      }),
    ).then((value) => {
      result = value;
      return value;
    });
    await entered.promise;
    if (reason === "abort") abort.abort();
    try {
      await vi.waitFor(
        () =>
          expect(result?.error).toMatchObject({
            code: reason === "abort" ? "cancelled" : "timed-out",
          }),
        { timeout: 500 },
      );
      await expect(fs.stat(options().stateRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      active = await startOpenCodeServer({ ...options(), command });
      const currentPid = active.pid;
      verification.resolve(command);
      await pending;
      expect(
        (await active.fetchJson<{ healthy: boolean }>("/global/health"))
          .healthy,
      ).toBe(true);
      expect(active.pid).toBe(currentPid);
    } finally {
      verification.resolve(command);
      const result = await pending;
      await result.value?.close();
    }
  },
);

it.each(["abort", "timeout"])(
  "confirms cleanup on %s before a protection callback settles and retains its proof",
  async (reason) => {
    const entered = deferred<OpenCodeProcessIdentity>(),
      protection = deferred();
    const abort = new AbortController();
    let result: Awaited<ReturnType<typeof outcome>> | undefined;
    const pending = outcome(
      startOpenCodeServer({
        ...options(),
        command,
        signal: abort.signal,
        startupTimeoutMs: reason === "timeout" ? 150 : 5000,
        beforeLaunch: async (identity) => {
          entered.resolve(identity);
          await protection.promise;
          throw new Error("private late protection failure");
        },
      }),
    ).then((value) => {
      result = value;
      return value;
    });
    const identity = await entered.promise;
    if (reason === "abort") abort.abort();
    try {
      await vi.waitFor(
        () =>
          expect(result?.error).toMatchObject({
            code: reason === "abort" ? "cancelled" : "timed-out",
          }),
        { timeout: 1000 },
      );
      expect(() => process.kill(identity.pid, 0)).toThrow();
      expect(
        JSON.parse(await fs.readFile(identity.cleanupProof.path, "utf8")),
      ).toEqual({ status: "complete", token: identity.cleanupProof.token });
      await expect(
        fs.stat(join(directory, "runtime.pid")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      active = await startOpenCodeServer({ ...options(), command });
      protection.resolve();
      await pending;
      expect(
        (await active.fetchJson<{ healthy: boolean }>("/global/health"))
          .healthy,
      ).toBe(true);
      expect(
        JSON.parse(await fs.readFile(identity.cleanupProof.path, "utf8")).token,
      ).toBe(identity.cleanupProof.token);
    } finally {
      protection.resolve();
      await pending;
    }
  },
);

it("reports unconfirmed cleanup if its proof cannot be read while protection is pending", async () => {
  const entered = deferred<OpenCodeProcessIdentity>(),
    protection = deferred();
  const abort = new AbortController();
  let result: Awaited<ReturnType<typeof outcome>> | undefined;
  const pending = outcome(
    startOpenCodeServer({
      ...options(),
      command,
      signal: abort.signal,
      beforeLaunch: async (identity) => {
        entered.resolve(identity);
        await protection.promise;
      },
    }),
  ).then((value) => {
    result = value;
    return value;
  });
  const identity = await entered.promise;
  vi.mocked(fs.readFile).mockImplementation(async (...args) => {
    if (String(args[0]) === identity.cleanupProof.path)
      throw new Error("controlled unreadable cleanup proof");
    return originalFs.readFile(...(args as Parameters<typeof fs.readFile>));
  });
  abort.abort();
  try {
    await vi.waitFor(
      () => expect(result?.error).toBeInstanceOf(OpenCodeShutdownError),
      { timeout: 1000 },
    );
    expect(() => process.kill(identity.pid, 0)).toThrow();
    expect(
      JSON.parse(await originalFs.readFile(identity.cleanupProof.path, "utf8"))
        .token,
    ).toBe(identity.cleanupProof.token);
  } finally {
    protection.resolve();
    await pending;
  }
});
