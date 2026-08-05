/**
 * Unit tests for the POST /api/connect/github handler.
 *
 * The git clone is mocked at the child-process seam — no network calls and no
 * real git binary required. Registration is intentionally tested elsewhere by
 * the existing workflows/connect contract; this route only returns the clone.
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
    execFile: vi.fn(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        callback: (err: unknown, stdout: string, stderr: string) => void,
      ) => {
        // Default: succeed silently. Tests override via mockClone.
        (callback as (err: null, stdout: string, stderr: string) => void)(
          null,
          "",
          "",
        );
        return { pid: 1 } as ReturnType<typeof actual.execFile>;
      },
    ),
  };
});

import { createConnectGitHubRouter, gitClone } from "./connect-github.js";
import {
  createGitHubDeviceRouter,
  _clearTokenStoreForTest,
} from "./github-device.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startServer(tmpDir: string): {
  baseUrl: string;
  close: () => Promise<void>;
} {
  const app = express();
  app.use(express.json());
  app.use(
    createConnectGitHubRouter({
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
    const execFile = await import("node:child_process").then((m) => m.execFile);
    vi.mocked(execFile).mockImplementationOnce((_cmd, _args, _opts, cb) => {
      (cb as unknown as (err: Error, stdout: string, stderr: string) => void)(
        Object.assign(new Error("clone failed"), {
          stderr:
            "fatal: repository 'https://user:TOKEN@github.com/x/y.git' not found",
        }),
        "",
        "fatal: repository 'https://user:TOKEN@github.com/x/y.git' not found",
      );
      return { pid: 1 } as ReturnType<
        typeof import("node:child_process").execFile
      >;
    });
    // The promisify wrapper in the module re-reads the mock on each call.
    await expect(
      gitClone("https://github.com/x/y.git", "/tmp/y"),
    ).rejects.toThrow(/\*\*\*@github\.com/);
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
    server = startServer(tmpDir);
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
    server = startServer(tmpDir);
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

    server = startServer(tmpDir);
    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/owner/my-repo",
        targetDir: existing,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not empty/i);
  });

  it("returns the derived targetDir for registration after a successful clone", async () => {
    server = startServer(tmpDir);
    const expectedDir = path.join(tmpDir, "my-repo");

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/owner/my-repo" }),
    });

    // The clone mock succeeds by default. Registration deliberately follows
    // through the existing workflows/connect client path.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(expectedDir);
  });

  it("uses the caller-supplied targetDir when provided", async () => {
    const customDir = path.join(tmpDir, "custom-location");
    server = startServer(tmpDir);

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/owner/repo",
        targetDir: customDir,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(customDir);
  });

  it("returns 500 when git clone fails", async () => {
    // Override the execFile mock to simulate a clone failure.
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementationOnce((_cmd, _args, _opts, cb) => {
      (cb as unknown as (err: Error, stdout: string, stderr: string) => void)(
        Object.assign(new Error("git clone failed"), {
          stderr: "fatal: not found",
        }),
        "",
        "fatal: not found",
      );
      return { pid: 1 } as ReturnType<
        typeof import("node:child_process").execFile
      >;
    });

    server = startServer(tmpDir);

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/owner/repo" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/git clone failed/i);
  });

  it("accepts SSH-style GitHub URLs", async () => {
    server = startServer(tmpDir);

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "git@github.com:owner/my-repo.git" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(path.join(tmpDir, "my-repo"));
  });

  it("keeps the token out of argv and supplies an ephemeral git auth header", async () => {
    const { execFile } = await import("node:child_process");
    // Capture git's argv and process-only environment.
    let capturedArgs: string[] = [];
    let capturedOptions: { env?: NodeJS.ProcessEnv } = {};
    vi.mocked(execFile).mockImplementationOnce((_cmd, args, opts, cb) => {
      capturedArgs = args as string[];
      capturedOptions = opts as { env?: NodeJS.ProcessEnv };
      (cb as unknown as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return { pid: 1 } as ReturnType<
        typeof import("node:child_process").execFile
      >;
    });

    const app = express();
    app.use(express.json());
    app.use(
      createConnectGitHubRouter({
        defaultCloneParent: tmpDir,
        // Inject a fixed token — mirrors how getGitHubToken feeds the route.
        getToken: () => "ghp_test_token",
      }),
    );
    const srv = app.listen(0);
    const addr = srv.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    server = {
      baseUrl,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };

    const res = await fetch(`${baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/owner/private-repo",
      }),
    });
    expect(res.status).toBe(200);
    // The canonical origin URL is credential-free, and the token never enters
    // argv (which also keeps it out of the cloned repository's .git/config).
    expect(capturedArgs).toContain("https://github.com/owner/private-repo.git");
    expect(capturedArgs.join(" ")).not.toContain("ghp_test_token");
    expect(capturedOptions.env?.GIT_CONFIG_KEY_0).toBe(
      "http.https://github.com/.extraheader",
    );
    expect(capturedOptions.env?.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from(
        "x-access-token:ghp_test_token",
      ).toString("base64")}`,
    );
    expect(capturedOptions.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("rejects the clone when production's OAuth session is missing", async () => {
    const { execFile } = await import("node:child_process");
    const cloneCallsBefore = vi.mocked(execFile).mock.calls.length;
    const app = express();
    app.use(express.json());
    app.use(
      createConnectGitHubRouter({
        defaultCloneParent: tmpDir,
        getToken: () => null,
      }),
    );
    const srv = app.listen(0);
    const addr = srv.address() as { port: number };
    server = {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/x/y" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "GitHub authorization expired. Connect GitHub again.",
    });
    expect(vi.mocked(execFile).mock.calls).toHaveLength(cloneCallsBefore);
  });

  it("redacts the token from git clone error messages", async () => {
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementationOnce((_cmd, _args, _opts, cb) => {
      (cb as unknown as (err: Error, stdout: string, stderr: string) => void)(
        Object.assign(new Error("clone failed"), {
          stderr:
            "fatal: repository 'https://x-access-token:ghp_secret@github.com/x/y.git' not found",
        }),
        "",
        "fatal: repo not found",
      );
      return { pid: 1 } as ReturnType<
        typeof import("node:child_process").execFile
      >;
    });

    const app = express();
    app.use(express.json());
    app.use(
      createConnectGitHubRouter({
        defaultCloneParent: tmpDir,
        getToken: () => "ghp_secret",
      }),
    );
    const srv = app.listen(0);
    const addr = srv.address() as { port: number };
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
    vi.mocked(execFile).mockImplementationOnce((_cmd, _args, _opts, cb) => {
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
      return { pid: 1 } as ReturnType<
        typeof import("node:child_process").execFile
      >;
    });

    const app = express();
    app.use(express.json());
    app.use(
      createConnectGitHubRouter({
        defaultCloneParent: tmpDir,
        getToken: () => "ghp_secret",
      }),
    );
    const srv = app.listen(0);
    const addr = srv.address() as { port: number };
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

  it("redacts a traced Authorization header from clone errors", async () => {
    const { execFile } = await import("node:child_process");
    const encoded = Buffer.from("x-access-token:ghp_secret").toString("base64");
    vi.mocked(execFile).mockImplementationOnce((_cmd, _args, _opts, cb) => {
      (cb as unknown as (err: Error, stdout: string, stderr: string) => void)(
        Object.assign(new Error("clone failed"), {
          stderr: `Authorization: basic ${encoded}`,
        }),
        "",
        "",
      );
      return { pid: 1 } as ReturnType<
        typeof import("node:child_process").execFile
      >;
    });

    const app = express();
    app.use(express.json());
    app.use(
      createConnectGitHubRouter({
        defaultCloneParent: tmpDir,
        getToken: () => "ghp_secret",
      }),
    );
    const srv = app.listen(0);
    const addr = srv.address() as { port: number };
    server = {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };

    const res = await fetch(`${server.baseUrl}/api/connect/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/x/y" }),
    });
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(500);
    expect(body.error).toContain("Authorization: basic ***");
    expect(body.error).not.toContain(encoded);
    expect(body.error).not.toContain("ghp_secret");
  });

  it("returns 400 for https://github.com/owner/..git (repo would be '.')", async () => {
    server = startServer(tmpDir);
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
    server = startServer(tmpDir);
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
// process-only auth header is used while argv stays credential-free.
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

  it("uses process-only auth when the gh_sess cookie reaches the clone route", async () => {
    // Capture git's credential-free argv and process-only auth environment.
    const { execFile } = await import("node:child_process");
    let capturedArgs: string[] = [];
    let capturedOptions: { env?: NodeJS.ProcessEnv } = {};
    vi.mocked(execFile).mockImplementationOnce((_cmd, args, opts, cb) => {
      capturedArgs = args as string[];
      capturedOptions = opts as { env?: NodeJS.ProcessEnv };
      (cb as unknown as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return { pid: 1 } as ReturnType<
        typeof import("node:child_process").execFile
      >;
    });

    // Build a mock fetch that simulates GitHub's Device Flow responses.
    const mockFetch = vi
      .fn()
      // poll: token endpoint
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "ghp_integration_token" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      // poll: /user endpoint for login
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ login: "testuser" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    // Mount BOTH routers on one Express app — exactly the production wiring.
    const { getGitHubToken } = await import("./github-device.js");
    const app = express();
    app.use(express.json());
    app.use(
      createGitHubDeviceRouter({
        fetchImpl: mockFetch as typeof fetch,
        clientId: "test-client",
      }),
    );
    app.use(
      createConnectGitHubRouter({
        defaultCloneParent: tmpDir,
        getToken: getGitHubToken,
      }),
    );

    const srv = app.listen(0);
    const addr = srv.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    server = {
      baseUrl,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };

    // Step 1: Poll the device endpoint to get the gh_sess cookie.
    const pollRes = await globalThis.fetch(
      `${baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "ghu_test_code" }),
      },
    );
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
      body: JSON.stringify({
        repoUrl: "https://github.com/owner/private-repo",
      }),
    });
    expect(cloneRes.status).toBe(200);

    // Step 3: argv and the persisted origin stay credential-free; auth exists
    // only in the child process environment for this clone.
    expect(capturedArgs).toContain("https://github.com/owner/private-repo.git");
    expect(capturedArgs.join(" ")).not.toContain("ghp_integration_token");
    expect(capturedOptions.env?.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from(
        "x-access-token:ghp_integration_token",
      ).toString("base64")}`,
    );
  });
});
