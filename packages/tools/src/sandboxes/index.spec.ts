/**
 * Sandbox exec/poll terminal-status handling + multipart upload lifecycle.
 *
 * The terminal-status tests are the regression guard for the bug that hung
 * workflow execution 7: the sandbox process API reports a non-zero exit as
 * status `"failed"` (not `"completed"`), and the client must surface that as an
 * `ExecResult` with the real exit code rather than polling to the timeout.
 *
 * All tests inject a routed fake fetch — no real network.
 */
import { Transport } from "../_client/index.js";
import { Sandbox } from "./index.js";

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: { get: (k: string) => string | null };
}

function ok(body: unknown): FakeResponse {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  };
}

function err(status: number, text = ""): FakeResponse {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
    headers: { get: () => null },
  };
}

/** Build a Sandbox whose transport routes through `route(url, init)`. */
function sandboxWith(
  route: (url: string, init: RequestInit) => FakeResponse,
): Sandbox {
  const fetchFn = (async (url: string, init: RequestInit = {}) =>
    route(
      url,
      init,
    ) as unknown as Response) as unknown as typeof globalThis.fetch;
  const transport = new Transport({ apiKey: "k", fetch: fetchFn });
  return Sandbox.attach("box", {}, transport);
}

describe("Sandbox.exec — terminal status handling", () => {
  it("returns the real exit code when the process polls to status 'failed' (regression: exec-7 hang)", async () => {
    let polls = 0;
    const box = sandboxWith((url, init) => {
      if ((init.method ?? "GET") === "POST" && url.endsWith("/process")) {
        return ok({ pid: "p1", status: "running" });
      }
      // GET status: running once, then failed with a non-zero exit code.
      polls += 1;
      return ok(
        polls < 2
          ? { pid: "p1", status: "running" }
          : { pid: "p1", status: "failed", exitCode: 1, stderr: "boom" },
      );
    });

    const res = await box.exec("cat /nope", { pollInterval: 1 });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("boom");
  });

  it("treats a synchronous 'failed' create response as terminal (no polling)", async () => {
    const box = sandboxWith((url, init) => {
      if ((init.method ?? "GET") === "POST" && url.endsWith("/process")) {
        return ok({ pid: "p2", status: "failed", exitCode: 2, stdout: "" });
      }
      throw new Error("should not poll a synchronously-terminal process");
    });

    const res = await box.exec("false");
    expect(res.exitCode).toBe(2);
  });

  it("defaults a terminal non-'completed' status with no exitCode to 1", async () => {
    const box = sandboxWith((url, init) => {
      if ((init.method ?? "GET") === "POST" && url.endsWith("/process"))
        return ok({ pid: "p3", status: "running" });
      return ok({ pid: "p3", status: "killed" }); // no exitCode field
    });
    const res = await box.exec("sleep 999", { pollInterval: 1 });
    expect(res.exitCode).toBe(1);
  });

  it("returns exitCode 0 on a clean completion", async () => {
    const box = sandboxWith((url, init) => {
      if ((init.method ?? "GET") === "POST" && url.endsWith("/process"))
        return ok({ pid: "p4", status: "running" });
      return ok({ pid: "p4", status: "completed", exitCode: 0, stdout: "hi" });
    });
    const res = await box.exec("echo hi", { pollInterval: 1 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hi");
  });
});

describe("Sandbox.execStream — post-stream status reconciliation", () => {
  /**
   * Route that returns a real streaming Response for `/logs/stream` (so
   * `res.body.getReader()` works) and FakeResponses for process create/status.
   */
  function streamSandbox(pollStatuses: Array<Record<string, unknown>>) {
    let polls = 0;
    return sandboxWith((url, init) => {
      if ((init.method ?? "GET") === "POST" && url.endsWith("/process")) {
        return ok({ pid: "p-stream", status: "running" });
      }
      if (/\/logs\/stream$/.test(url)) {
        // Real Response so ReadableStream is available to execStream.
        return new Response("stdout:hello\n") as unknown as FakeResponse;
      }
      const body = pollStatuses[Math.min(polls, pollStatuses.length - 1)]!;
      polls += 1;
      return ok({ pid: "p-stream", ...body });
    });
  }

  it("reconciles an exit code reported after the log stream ends", async () => {
    jest.useFakeTimers();
    try {
      const box = streamSandbox([
        { status: "running" },
        { status: "failed", exitCode: 3 },
      ]);

      const stream = await box.execStream("false");
      const drained = (async () => {
        const seen: Array<{ stream: string; data: string }> = [];
        for await (const line of stream.output) seen.push(line);
        return seen;
      })();

      await jest.advanceTimersByTimeAsync(1_000);

      expect(await drained).toEqual([{ stream: "stdout", data: "hello" }]);
      expect(stream.exitCode).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  // Regression: the reconciliation poll above ran with no deadline, so a
  // process that never reports a terminal status hung the consumer forever
  // instead of failing with the exec timeout every other poll path applies.
  it("times out when the process never reaches a terminal status", async () => {
    jest.useFakeTimers();
    try {
      const box = streamSandbox([{ status: "running" }]);

      const stream = await box.execStream("sleep 999");
      const drained = (async () => {
        for await (const line of stream.output) void line;
      })();
      const rejection = expect(drained).rejects.toThrow(
        "Process p-stream timed out after 60000ms",
      );

      await jest.advanceTimersByTimeAsync(60_000);
      await rejection;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("Sandbox.uploadFile — multipart lifecycle", () => {
  it("initiates, uploads each part, and completes", async () => {
    const calls: string[] = [];
    const box = sandboxWith((url, init) => {
      const method = (init.method ?? "GET") as string;
      if (url.includes("/multipart/initiate/")) {
        calls.push("initiate");
        return ok({ uploadId: "u1", path: "big.bin" });
      }
      if (url.includes("/multipart/u1/part") && method === "PUT") {
        const partNumber = Number(new URL(url).searchParams.get("partNumber"));
        calls.push(`part:${partNumber}`);
        return ok({ partNumber, etag: `e${partNumber}`, size: 5 });
      }
      if (url.endsWith("/multipart/u1/complete") && method === "POST") {
        calls.push("complete");
        return ok({ message: "ok", path: "big.bin" });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    // 12 bytes at a 5-byte part size → 3 parts.
    await box.uploadFile("big.bin", new Uint8Array(12), { partSize: 5 });

    expect(calls).toEqual([
      "initiate",
      "part:1",
      "part:2",
      "part:3",
      "complete",
    ]);
  });

  it("aborts the upload when a part fails", async () => {
    const calls: string[] = [];
    const box = sandboxWith((url, init) => {
      const method = (init.method ?? "GET") as string;
      if (url.includes("/multipart/initiate/"))
        return ok({ uploadId: "u2", path: "f" });
      if (url.includes("/multipart/u2/part") && method === "PUT")
        return err(400, "bad part");
      if (url.endsWith("/multipart/u2") && method === "DELETE") {
        calls.push("abort");
        return ok({});
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await expect(
      box.uploadFile("f", new Uint8Array(3), { partSize: 5, maxRetries: 0 }),
    ).rejects.toThrow();
    // Abort is best-effort/fire-and-forget; let the microtask flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("abort");
  });
});

describe("Sandbox.get / Sandbox.list — read-only metadata", () => {
  function transportRouting(
    route: (url: string, init: RequestInit) => FakeResponse,
  ): Transport {
    const fetchFn = (async (url: string, init: RequestInit = {}) =>
      route(
        url,
        init,
      ) as unknown as Response) as unknown as typeof globalThis.fetch;
    return new Transport({ apiKey: "k", fetch: fetchFn });
  }

  const info = {
    name: "box-1",
    source: "user",
    status: "running",
    tier: "s",
    url: "https://box-1.preview",
    workspaceRoot: "/workspace",
    expiresAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };

  it("get() fetches a single sandbox's metadata by name", async () => {
    let seen = "";
    const t = transportRouting((url) => {
      seen = url;
      return ok(info);
    });
    const result = await Sandbox.get("box-1", { baseUrl: "https://sbx" }, t);
    expect(seen).toBe("https://sbx/v1/sandboxes/box-1");
    expect(result).toEqual(info);
  });

  it("get() URL-encodes the name", async () => {
    let seen = "";
    const t = transportRouting((url) => {
      seen = url;
      return ok(info);
    });
    await Sandbox.get("a/b", { baseUrl: "https://sbx" }, t);
    expect(seen).toBe("https://sbx/v1/sandboxes/a%2Fb");
  });

  it("get() throws when the sandbox does not exist", async () => {
    const t = transportRouting(() => err(404, "not found"));
    await expect(
      Sandbox.get("missing", { baseUrl: "https://sbx" }, t),
    ).rejects.toThrow();
  });

  it("list() unwraps and returns the sandboxes array", async () => {
    let seen = "";
    const t = transportRouting((url) => {
      seen = url;
      return ok({ sandboxes: [info, { ...info, name: "box-2" }] });
    });
    const result = await Sandbox.list({ baseUrl: "https://sbx" }, t);
    expect(seen).toBe("https://sbx/v1/sandboxes");
    expect(result.map((s) => s.name)).toEqual(["box-1", "box-2"]);
  });
});

describe("Sandbox.createPublicUrl", () => {
  it("POSTs the metadata/spec body and maps spec.url to url", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const box = sandboxWith((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse((init.body as string) ?? "{}");
      return ok({
        metadata: { name: "web" },
        spec: { url: "https://abc123.us.preview.bl.run", port: 3000 },
      });
    });
    const preview = await box.createPublicUrl({ port: 3000, name: "web" });
    expect(seenUrl.endsWith("/v1/sandboxes/box/previews")).toBe(true);
    expect(seenBody).toEqual({
      metadata: { name: "web" },
      spec: { port: 3000, public: true },
    });
    expect(preview).toEqual({
      url: "https://abc123.us.preview.bl.run",
      name: "web",
    });
  });

  it("includes prefixUrl when a prefix is given and honors public:false", async () => {
    let seenBody: Record<string, unknown> = {};
    const box = sandboxWith((_url, init) => {
      seenBody = JSON.parse((init.body as string) ?? "{}");
      return ok({ spec: { url: "https://my-prefix.preview.bl.run" } });
    });
    await box.createPublicUrl({ port: 8080, public: false, prefix: "my-prefix" });
    expect(seenBody.spec).toEqual({
      port: 8080,
      public: false,
      prefixUrl: "my-prefix",
    });
  });

  it("throws on a non-2xx response", async () => {
    const box = sandboxWith(() => err(400, "port 3000 does not exist"));
    await expect(box.createPublicUrl({ port: 3000 })).rejects.toThrow(
      /Failed to create public URL: 400/,
    );
  });
});

describe("Sandbox.deployPreview", () => {
  it("POSTs to /preview/deploy with build/start/port and returns { url, status, logs }", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const box = sandboxWith((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse((init.body as string) ?? "{}");
      return ok({ url: "https://xyz.preview.bl.run", status: "deployed", logs: "" });
    });
    const result = await box.deployPreview({
      build: "npm install",
      start: "node server.js",
      port: 3000,
      env: { NODE_ENV: "production" },
    });
    expect(seenUrl.endsWith("/v1/sandboxes/box/preview/deploy")).toBe(true);
    expect(seenBody).toEqual({
      build: "npm install",
      start: "node server.js",
      port: 3000,
      env: { NODE_ENV: "production" },
    });
    expect(result).toEqual({ url: "https://xyz.preview.bl.run", status: "deployed", logs: "" });
  });

  it("passes through a failed status + logs without throwing", async () => {
    const box = sandboxWith(() => ok({ url: null, status: "failed", logs: "npm ERR! boom" }));
    const result = await box.deployPreview({ start: "node server.js", port: 3000 });
    expect(result.status).toBe("failed");
    expect(result.logs).toContain("boom");
  });

  it("forwards a git source verbatim in the body", async () => {
    let seenBody: Record<string, unknown> = {};
    const box = sandboxWith((_url, init) => {
      seenBody = JSON.parse((init.body as string) ?? "{}");
      return ok({ url: "https://g.preview.bl.run", status: "deployed", logs: "" });
    });
    await box.deployPreview({ source: { kind: "git", repo: "my-app", ref: "main" }, start: "node server.js", port: 3000 });
    expect(seenBody.source).toEqual({ kind: "git", repo: "my-app", ref: "main" });
  });
});
