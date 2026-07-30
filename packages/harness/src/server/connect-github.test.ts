/**
 * Unit tests for the POST /api/connect/github handler.
 *
 * The git clone is mocked at the `gitClone` function seam — no network calls,
 * no real git binary required. The workflow registry is a lightweight stub.
 */

import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the execFileAsync used inside gitClone so no real git binary runs.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, callback: (err: unknown, stdout: string, stderr: string) => void) => {
      // Default: succeed silently. Tests override via mockClone.
      (callback as (err: null, stdout: string, stderr: string) => void)(null, "", "");
      return { pid: 1 } as ReturnType<typeof actual.execFile>;
    }),
  };
});

import { createConnectGitHubRouter, gitClone } from "./connect-github.js";
import {
  createGitHubDeviceRouter,
  _clearTokenStoreForTest,
} from "./github-device.js";
import type { WorkflowRegistryLike } from "../core/workflow-registry.js";
import type { WorkflowInfo } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRegistry(overrides: Partial<WorkflowRegistryLike> = {}): WorkflowRegistryLike {
  return {
    list: vi.fn().mockResolvedValue([]),
    scan: vi.fn().mockResolvedValue([]),
    connectPath: vi.fn().mockImplementation(async (p: string): Promise<WorkflowInfo> => ({
      name: path.basename(p),
      path: p,
      definitionId: null,
      definitionSlug: null,
      source: "connect",
    })),
    ...overrides,
  };
}

function startServer(
  registry: WorkflowRegistryLike,
  tmpDir: string,
): { baseUrl: string; close: () => Promise<void> } {
  const app = express();
  app.use(express.json());
  app.use(
    createConnectGitHubRouter({
      registry,
      defaultCloneParent: tmpDir,
    }),
  );
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Unit tests for gitClone (isolated, no HTTP)
// ---------------------------------------------------------------------------

describe("gitClone", () => {
  it("rejects with a redacted error when the mock simulates a clone failure", async () => {
    // Arrange: make the promisified execFile reject with a fake stderr.
    const { promisify } = await import("node:util");
    const execFile = await import("node:child_process").then((m) => m.execFile);
    vi.mocked(execFile).mockImplementationOnce(
      (_cmd, _args, _opts, cb) => {
        (cb as unknown as (err: Error, stdout: string, stderr: string) => void)(
          Object.assign(new Error("clone failed"), { stderr: "fatal: repository 'https://user:TOKEN@github.com/x/y.git' not found" }),
          "",
          "fatal: repository 'https://user:TOKEN@github.com/x/y.git' not found",
        );
        return { pid: 1 } as ReturnType<typeof import("node:child_process").execFile>;
      },
    );
    // The promisify wrapper in the module re-reads the mock on each call.
    await expect(gitClone("https://github.com/x/y.git", "/tmp/y")).rejects.toThrow(
      /\*\*\*@github\.com/,
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP handler tests
// ---------------------------------------------------------------------------

describe("POST /api/connect/github", () => {
  let tmpDir: string;
  let server: { baseUrl: string; close: () => Promise<void> };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "connect-github-test-"));
  });

  afterEach(async () => {
    await server?.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 400 when repoUrl is missing", async () => {
    const registry = fakeRegistry();
    server = startServer(registry, tmpDir);
    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/repoUrl/i);
  });

  it("returns 400 for an invalid (non-GitHub) URL", async () => {
    const registry = fakeRegistry();
    server = startServer(registry, tmpDir);
    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://gitlab.com/owner/repo" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid GitHub URL/i);
  });

  it("returns 400 when targetDir already exists and is non-empty", async () => {
    // Create a non-empty target directory.
    const existing = path.join(tmpDir, "my-repo");
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "README.md"), "hello");

    const registry = fakeRegistry();
    server = startServer(registry, tmpDir);
    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/owner/my-repo", targetDir: existing }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not empty/i);
  });

  it("calls connectPath with the correct targetDir on a successful mock clone", async () => {
    const registry = fakeRegistry();
    server = startServer(registry, tmpDir);
    const expectedDir = path.join(tmpDir, "my-repo");

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/owner/my-repo" }),
    });

    // The clone mock succeeds by default; registry.connectPath is called with the derived dir.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(expectedDir);
    expect(registry.connectPath).toHaveBeenCalledWith(expectedDir);
  });

  it("uses the caller-supplied targetDir when provided", async () => {
    const customDir = path.join(tmpDir, "custom-location");
    const registry = fakeRegistry();
    server = startServer(registry, tmpDir);

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/owner/repo", targetDir: customDir }),
    });
    expect(res.status).toBe(200);
    expect(registry.connectPath).toHaveBeenCalledWith(customDir);
  });

  it("returns 500 when git clone fails", async () => {
    // Override the execFile mock to simulate a clone failure.
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementationOnce(
      (_cmd, _args, _opts, cb) => {
        (cb as unknown as (err: Error, stdout: string, stderr: string) => void)(
          Object.assign(new Error("git clone failed"), { stderr: "fatal: not found" }),
          "",
          "fatal: not found",
        );
        return { pid: 1 } as ReturnType<typeof import("node:child_process").execFile>;
      },
    );

    const registry = fakeRegistry();
    server = startServer(registry, tmpDir);

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/owner/repo" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/git clone failed/i);
    // connectPath must NOT be called when clone failed.
    expect(registry.connectPath).not.toHaveBeenCalled();
  });

  it("accepts SSH-style GitHub URLs", async () => {
    const registry = fakeRegistry();
    server = startServer(registry, tmpDir);

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "git@github.com:owner/my-repo.git" }),
    });
    expect(res.status).toBe(200);
    expect(registry.connectPath).toHaveBeenCalledWith(path.join(tmpDir, "my-repo"));
  });

  it("uses the authenticated URL when a token is provided via getToken", async () => {
    const registry = fakeRegistry();
    const { execFile } = await import("node:child_process");
    // Capture what URL git clone was called with.
    let capturedArgs: string[] = [];
    vi.mocked(execFile).mockImplementationOnce(
      (_cmd, args, _opts, cb) => {
        capturedArgs = args as string[];
        (cb as unknown as (err: null, stdout: string, stderr: string) => void)(null, "", "");
        return { pid: 1 } as ReturnType<typeof import("node:child_process").execFile>;
      },
    );

    const app = express();
    app.use(express.json());
    app.use(
      createConnectGitHubRouter({
        registry,
        defaultCloneParent: tmpDir,
        // Inject a fixed token — mirrors how getGitHubToken feeds the route.
        getToken: () => "ghp_test_token",
      }),
    );
    const srv = app.listen(0);
    const addr = (srv.address() as { port: number });
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    server = { baseUrl, close: () => new Promise<void>((r) => srv.close(() => r())) };

    const res = await fetch(`${baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/owner/private-repo" }),
    });
    expect(res.status).toBe(200);
    // The clone URL must use the x-access-token form, NOT the original URL.
    expect(capturedArgs).toContain(
      "https://x-access-token:ghp_test_token@github.com/owner/private-repo.git",
    );
  });

  it("redacts the token from git clone error messages", async () => {
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementationOnce(
      (_cmd, _args, _opts, cb) => {
        (cb as unknown as (err: Error, stdout: string, stderr: string) => void)(
          Object.assign(new Error("clone failed"), {
            stderr:
              "fatal: repository 'https://x-access-token:ghp_secret@github.com/x/y.git' not found",
          }),
          "",
          "fatal: repo not found",
        );
        return { pid: 1 } as ReturnType<typeof import("node:child_process").execFile>;
      },
    );

    const registry = fakeRegistry();
    const app = express();
    app.use(express.json());
    app.use(
      createConnectGitHubRouter({
        registry,
        defaultCloneParent: tmpDir,
        getToken: () => "ghp_secret",
      }),
    );
    const srv = app.listen(0);
    const addr = (srv.address() as { port: number });
    server = {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/x/y" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    // The error must NOT contain the raw token.
    expect(body.error).not.toContain("ghp_secret");
    // The URL should be redacted.
    expect(body.error).toContain("***@github.com");
  });

  it("redacts the token from err.message when stderr is empty", async () => {
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementationOnce(
      (_cmd, _args, _opts, cb) => {
        // stderr empty — error is only surfaced via err.message.
        (cb as unknown as (err: Error, stdout: string, stderr: string) => void)(
          Object.assign(
            new Error(
              "Command failed: git clone -- https://x-access-token:ghp_secret@github.com/x/y.git /tmp/y",
            ),
            { stderr: "" },
          ),
          "",
          "",
        );
        return { pid: 1 } as ReturnType<typeof import("node:child_process").execFile>;
      },
    );

    const registry = fakeRegistry();
    const app = express();
    app.use(express.json());
    app.use(
      createConnectGitHubRouter({
        registry,
        defaultCloneParent: tmpDir,
        getToken: () => "ghp_secret",
      }),
    );
    const srv = app.listen(0);
    const addr = (srv.address() as { port: number });
    server = {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/x/y" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("ghp_secret");
    expect(body.error).toContain("***@github.com");
  });

  it("returns 400 for https://github.com/owner/..git (repo would be '.')", async () => {
    const registry = fakeRegistry();
    server = startServer(registry, tmpDir);
    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/owner/..git" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid GitHub URL/i);
  });

  it("returns 400 when targetDir escapes the home directory", async () => {
    const registry = fakeRegistry();
    server = startServer(registry, tmpDir);
    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/owner/repo",
        targetDir: "/Library/LaunchAgents/evil",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/home directory/i);
  });
});

// ---------------------------------------------------------------------------
// A6: Integration test — Device Flow cookie reaches /api/connect/github
//
// This test mounts BOTH routers on one Express app, obtains a gh_sess cookie
// via the device poll endpoint (with the corrected Path=/api/ scope), then
// calls /api/connect/github WITH that cookie and asserts the authenticated
// (token) clone URL is used.  It would have caught A1 directly.
// ---------------------------------------------------------------------------

describe("GitHub Device Flow + clone integration (A6)", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  let tmpDir: string;

  beforeEach(async () => {
    _clearTokenStoreForTest();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-device-clone-test-"));
  });

  afterEach(async () => {
    await server?.close();
    _clearTokenStoreForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("uses the authenticated clone URL when the gh_sess cookie is forwarded from /api/github to /api/connect/github", async () => {
    // Capture the URL that git clone was invoked with.
    const { execFile } = await import("node:child_process");
    let capturedArgs: string[] = [];
    vi.mocked(execFile).mockImplementationOnce(
      (_cmd, args, _opts, cb) => {
        capturedArgs = args as string[];
        (cb as unknown as (err: null, stdout: string, stderr: string) => void)(null, "", "");
        return { pid: 1 } as ReturnType<typeof import("node:child_process").execFile>;
      },
    );

    // Build a mock fetch that simulates GitHub's Device Flow responses.
    const mockFetch = vi
      .fn()
      // poll: token endpoint
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ghp_integration_token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      // poll: /user endpoint for login
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ login: "testuser" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const registry = fakeRegistry();

    // Mount BOTH routers on one Express app — exactly the production wiring.
    const { getGitHubToken } = await import("./github-device.js");
    const app = express();
    app.use(express.json());
    app.use(
      createGitHubDeviceRouter({ fetchImpl: mockFetch as typeof fetch, clientId: "test-client" }),
    );
    app.use(
      createConnectGitHubRouter({
        registry,
        defaultCloneParent: tmpDir,
        getToken: getGitHubToken,
      }),
    );

    const srv = app.listen(0);
    const addr = srv.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    server = { baseUrl, close: () => new Promise<void>((r) => srv.close(() => r())) };

    // Step 1: Poll the device endpoint to get the gh_sess cookie.
    const pollRes = await globalThis.fetch(`${baseUrl}/api/github/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: "ghu_test_code" }),
    });
    expect(pollRes.status).toBe(200);
    const pollBody = (await pollRes.json()) as { status: string };
    expect(pollBody.status).toBe("authorized");

    // Extract the Set-Cookie header — this is the gh_sess with Path=/api/
    const setCookie = pollRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("gh_sess=");
    expect(setCookie).toContain("Path=/api/");
    const sessionCookie = setCookie.split(";")[0]; // "gh_sess=<value>"

    // Step 2: Call /api/connect/github WITH the cookie — the route is under
    // Path=/api/ so the browser would include it; we forward it explicitly here.
    const cloneRes = await globalThis.fetch(`${baseUrl}/api/connect/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({ repoUrl: "https://github.com/owner/private-repo" }),
    });
    expect(cloneRes.status).toBe(200);

    // Step 3: The clone URL must use the authenticated form, not the raw URL.
    expect(capturedArgs).toContain(
      "https://x-access-token:ghp_integration_token@github.com/owner/private-repo.git",
    );
  });
});
