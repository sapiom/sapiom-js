import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { OpenCodeShutdownError } from "@sapiom/opencode";
import type { AssistantGrant } from "./assistant-access.js";
import { OpenCodeHost, OpenCodeTransportError } from "./opencode-host.js";

let root: string;
let cwd: string;
let host: OpenCodeHost;
let grant: AssistantGrant | null;
let changed: () => void;
let expectShutdownFailure = false;
const authorize = vi.fn();
const start = vi.fn();
const revoke = vi.fn();
const close = vi.fn();
const issue = vi.fn();
const neverExited = new Promise<void>(() => {});
const cleanupProofFor = (stateRoot: string, hex: string) => ({
  path: join(stateRoot, `cleanup-${hex.repeat(32)}.json`),
  token: hex.repeat(64),
});
beforeEach(async () => {
  expectShutdownFailure = false;
  root = await mkdtemp(join(tmpdir(), "studio-opencode-host-"));
  cwd = join(root, "project");
  await mkdir(cwd);
  grant = {
    userId: "user",
    tenantId: "tenant",
    identityRevision: "revision",
    expiresAt: Date.now() + 60000,
    environment: {
      name: "production",
      appURL: "https://app.sapiom.ai",
      apiURL: "https://api.sapiom.ai",
      services: {},
      credentials: {
        apiKey: "sk_private",
        apiKeyId: "key",
        tenantId: "tenant",
        organizationName: "Org",
      },
    },
  };
  authorize
    .mockReset()
    .mockImplementation(async (id) => ({ harnessSessionId: id, cwd }));
  close.mockReset().mockResolvedValue(undefined);
  revoke.mockReset();
  issue.mockReset().mockReturnValue({ id: "runtime", token: "scoped", revoke });
  start.mockReset().mockResolvedValue({
    pid: 123,
    exited: neverExited,
    fetch: vi.fn(),
    fetchJson: vi.fn(),
    close,
  });
  host = new OpenCodeHost({
    access: {
      get: () => grant,
      getFailureCode: () =>
        grant ? "transport_unavailable" : "authentication_required",
      subscribe: (listener) => {
        changed = listener;
        return () => {};
      },
    },
    bridge: { issue, model: "smart" },
    origin: () => "http://127.0.0.1:1234",
    stateRoot: root,
    authorize,
    start,
  });
});
afterEach(async () => {
  if (expectShutdownFailure)
    await expect(host.close()).rejects.toThrow("shutdown");
  else await host.close();
  await rm(root, { recursive: true, force: true });
});

describe("Studio-owned OpenCode lifecycle", () => {
  it("coalesces attachments and uses only the authorized cwd and private state", async () => {
    const [first, second] = await Promise.all([
      host.ensure("studio-one"),
      host.ensure("studio-one"),
    ]);
    expect(first).toBe(second);
    expect(start).toHaveBeenCalledOnce();
    expect(first.cwd).toBe(cwd);
    expect(first.harnessSessionId).toBe("studio-one");
    expect(first.stateRoot.startsWith(join(root, "opencode"))).toBe(true);
    expect(JSON.stringify(start.mock.calls)).not.toContain("sk_private");
    expect(start.mock.calls[0][0].config.model).toBe("sapiom/smart");
    await host.ensure("studio-two");
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0][0].stateRoot).not.toBe(
      start.mock.calls[1][0].stateRoot,
    );
  });

  it("durably protects the runtime identity before accepting native launch", async () => {
    let cleanupProof: ReturnType<typeof cleanupProofFor> | undefined;
    start.mockImplementationOnce(async (options) => {
      expect(options.beforeLaunch).toEqual(expect.any(Function));
      await mkdir(options.stateRoot, { recursive: true });
      cleanupProof = cleanupProofFor(options.stateRoot, "a");
      await options.beforeLaunch!({
        pid: process.pid,
        cleanupProof,
      });
      const runtimeRoot = join(options.stateRoot, "..");
      const guardName = (await readdir(runtimeRoot)).find((name) =>
        name.startsWith("runtime.lock.guard-"),
      );
      expect(guardName).toBeDefined();
      expect(
        JSON.parse(await readFile(join(runtimeRoot, guardName!), "utf8")),
      ).toMatchObject({
        version: 2,
        pid: process.pid,
        cleanupProof: {
          relativePath: relative(runtimeRoot, cleanupProof.path),
          token: cleanupProof.token,
        },
      });
      return {
        pid: process.pid,
        exited: neverExited,
        fetch: vi.fn(),
        fetchJson: vi.fn(),
        close,
      };
    });
    close.mockImplementationOnce(async () => {
      if (!cleanupProof) throw new Error("missing cleanup proof");
      await writeFile(
        cleanupProof.path,
        `${JSON.stringify({ status: "complete", token: cleanupProof.token })}\n`,
      );
    });

    await host.ensure("studio-one");
    await host.retire("studio-one");
    expect(start).toHaveBeenCalledOnce();
  });

  it("sanitizes rejected runtime protection and releases it for explicit retry", async () => {
    start.mockImplementationOnce(async (options) => {
      await mkdir(options.stateRoot, { recursive: true });
      await options.beforeLaunch!({
        pid: 0,
        cleanupProof: cleanupProofFor(options.stateRoot, "b"),
      });
      throw new Error("unreachable");
    });

    const failure = await host.ensure("studio-one").catch((error) => error);
    expect(failure).toMatchObject({
      failure: { code: "runtime_start_failed" },
    });
    expect(failure.failure).not.toHaveProperty("reason");
    expect(JSON.stringify(failure.failure)).not.toContain("invalid-cleanup");
    expect(revoke).toHaveBeenCalledOnce();
    await host.ensure("studio-one");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("aborts a pending protection before a late authority can launch native", async () => {
    let cleanupProof: ReturnType<typeof cleanupProofFor> | undefined;
    let nativeLaunchAdmitted = false;
    start.mockImplementationOnce(async (options) => {
      await mkdir(options.stateRoot, { recursive: true });
      cleanupProof = cleanupProofFor(options.stateRoot, "c");
      const protection = options.beforeLaunch!({
        pid: process.pid,
        cleanupProof,
      });
      grant = null;
      changed();
      await protection;
      if (!options.signal.aborted) nativeLaunchAdmitted = true;
      return {
        pid: process.pid,
        exited: neverExited,
        fetch: vi.fn(),
        fetchJson: vi.fn(),
        close,
      };
    });
    close.mockImplementationOnce(async () => {
      if (!cleanupProof) throw new Error("missing cleanup proof");
      await writeFile(
        cleanupProof.path,
        `${JSON.stringify({ status: "complete", token: cleanupProof.token })}\n`,
      );
    });

    await expect(host.ensure("studio-one")).rejects.toMatchObject({
      failure: { code: "authentication_required" },
    });
    expect(nativeLaunchAdmitted).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalled();
  });

  it("does not inspect workspaces or start a process when access is off", async () => {
    grant = null;
    await expect(host.ensure("studio-one")).rejects.toThrow("unavailable");
    expect(authorize).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("rejects unauthorized workspaces and changing authority during authorization", async () => {
    authorize.mockResolvedValueOnce(null);
    await expect(host.ensure("studio-one")).rejects.toThrow("workspace");
    authorize.mockImplementationOnce(async (id) => {
      grant = null;
      changed();
      return { harnessSessionId: id, cwd };
    });
    await expect(host.ensure("studio-one")).rejects.toThrow("access changed");
    expect(start).not.toHaveBeenCalled();
  });

  it("releases failed startup so retry can acquire the same state", async () => {
    start.mockRejectedValueOnce(new Error("startup failed"));
    await expect(host.ensure("studio-one")).rejects.toMatchObject({
      failure: { code: "runtime_start_failed" },
    });
    expect(revoke).toHaveBeenCalledOnce();
    await host.ensure("studio-one");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("retires an existing runtime when workspace authorization is withdrawn", async () => {
    const attached = await host.ensure("studio-one");
    authorize.mockResolvedValue(null);
    await expect(host.ensure("studio-one")).rejects.toThrow("workspace");
    expect(attached.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborts and closes a late startup after access revocation", async () => {
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    start.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { pid: 123, exited: neverExited, close };
    });
    const pending = host.ensure("studio-one");
    const rejected = expect(pending).rejects.toThrow("access changed");
    await entered;
    grant = null;
    changed();
    finish();
    await rejected;
    await host.close();
    expect(start.mock.calls[0][0].signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalled();
  });

  it("keeps attachment alive without a browser, revokes on verified-user changes, and closes idempotently", async () => {
    const attachment = await host.ensure("studio-one");
    expect(close).not.toHaveBeenCalled();
    grant = { ...grant!, userId: "new-user" };
    changed();
    expect(attachment.signal.aborted).toBe(true);
    expect(attachment.signal.reason).toMatchObject({
      failure: { code: "access_denied" },
    });
    await Promise.all([host.close(), host.close()]);
    expect(close).toHaveBeenCalledOnce();
    await expect(host.ensure("studio-one")).rejects.toThrow("unavailable");
  });

  it("retains the owner lock if a revoked late startup cannot be stopped", async () => {
    expectShutdownFailure = true;
    const saved = grant;
    let finish!: (server: unknown) => void;
    start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = host.ensure("studio-one");
    const rejected = expect(pending).rejects.toThrow("shutdown");
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    grant = null;
    changed();
    close.mockRejectedValue(new Error("still alive"));
    finish({ pid: 123, exited: neverExited, close });
    await rejected;
    await expect(
      access(join(start.mock.calls[0][0].stateRoot, "..", "runtime.lock")),
    ).resolves.toBeUndefined();
    grant = saved;
    changed();
    await expect(host.ensure("studio-one")).rejects.toMatchObject({
      failure: { code: "transport_unavailable" },
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it("retains the owner lock when startup cannot prove native cleanup", async () => {
    expectShutdownFailure = true;
    start.mockRejectedValueOnce(new OpenCodeShutdownError());

    await expect(host.ensure("studio-one")).rejects.toThrow("shutdown");
    await expect(
      access(join(start.mock.calls[0][0].stateRoot, "..", "runtime.lock")),
    ).resolves.toBeUndefined();
    await expect(host.ensure("studio-one")).rejects.toMatchObject({
      failure: { code: "transport_unavailable" },
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it("rechecks workspace authorization after retirement and after native startup", async () => {
    await host.ensure("studio-one");
    let finish!: () => void;
    close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const retiring = host.retire("studio-one");
    const pending = host.ensure("studio-two");
    const rejected = expect(pending).rejects.toThrow("workspace");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    authorize.mockResolvedValue(null);
    finish();
    await retiring;
    await rejected;
    expect(start).toHaveBeenCalledOnce();
    authorize.mockImplementation(async (id) => ({ harnessSessionId: id, cwd }));
    start.mockImplementationOnce(async () => {
      authorize.mockResolvedValue(null);
      return { pid: 456, exited: neverExited, close };
    });
    await expect(host.ensure("studio-two")).rejects.toThrow("workspace");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("waits for every runtime cleanup even when one shutdown fails", async () => {
    expectShutdownFailure = true;
    await host.ensure("studio-one");
    await host.ensure("studio-two");
    let finish!: () => void;
    close.mockRejectedValueOnce(new Error("still alive"));
    close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let settled = false;
    const shutdown = host.close().finally(() => {
      settled = true;
    });
    const rejected = expect(shutdown).rejects.toThrow("shutdown");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    finish();
    await rejected;
  });

  it("retires a confirmed exited process so retry can reopen the same persistent state", async () => {
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    start.mockResolvedValueOnce({ pid: 123, exited, close });
    const first = await host.ensure("studio-one");
    exit();
    await vi.waitFor(() => expect(first.signal.aborted).toBe(true));
    const restored = await host.ensure("studio-one");
    expect(restored.stateRoot).toBe(first.stateRoot);
    expect(start).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("maps only the bounded native startup reason and suppresses expected cancellation", async () => {
    start.mockRejectedValueOnce({
      code: "permission-denied",
      message: "/private/runtime/path",
    });
    await expect(host.ensure("studio-one")).rejects.toMatchObject({
      failure: {
        code: "runtime_start_failed",
        reason: "permission-denied",
        retryable: false,
        action: "open_settings",
      },
    });
    start.mockImplementationOnce(async ({ signal }) => {
      grant = null;
      changed();
      signal.throwIfAborted();
      throw new OpenCodeTransportError({} as never);
    });
    await expect(host.ensure("studio-one")).rejects.toMatchObject({
      failure: { code: "authentication_required" },
    });
  });
});
