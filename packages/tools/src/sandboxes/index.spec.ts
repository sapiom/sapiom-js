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
