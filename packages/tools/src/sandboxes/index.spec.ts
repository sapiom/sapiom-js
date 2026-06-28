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
import { createClient } from "../index.js";
import { Sandbox, deploy, createPreview } from "./index.js";

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

// ---------------------------------------------------------------------------
// deploy() / createPreview() — exact URL/method/body/header assertions via a
// real Transport plus a scripted fetch (so we also verify tenant-credential
// injection and the preview-URL normalization).
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeTransport(
  handlers: Array<
    (call: FetchCall) => Response | Promise<Response> | null | undefined
  >,
  apiKey: string | undefined = "test-key",
): { transport: Transport; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    for (const handler of handlers) {
      const response = await handler({ url, init });
      if (response) return response;
    }
    throw new Error(`Unmatched mock fetch: ${init.method ?? "GET"} ${url}`);
  }) as typeof globalThis.fetch;
  return { transport: new Transport({ apiKey, fetch: fetchMock }), calls };
}

const BASE = "https://api.test";
const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];

const deployResponse = (overrides: Record<string, unknown> = {}) => ({
  name: "my-api",
  status: "running",
  source: "sandbox",
  tier: "s",
  url: "https://my-api.compute.example.com",
  createdAt: "2026-06-27T12:00:00.000Z",
  ...overrides,
});

describe("deploy()", () => {
  it("POSTs /v1/sandboxes/:name/deploy with files body + credential, returns the record", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(deployResponse()),
    ]);

    const result = await deploy(
      {
        name: "my-api",
        files: { "index.js": "console.log('hi')" },
        entrypoint: "node index.js",
        runtime: "node",
      },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/sandboxes/my-api/deploy`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      files: { "index.js": "console.log('hi')" },
      entrypoint: "node index.js",
      runtime: "node",
    });

    expect(result).toEqual(deployResponse());
  });

  it("omits undefined optional fields from the body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(deployResponse()),
    ]);

    await deploy({ name: "my-api", files: { "a.js": "1" } }, transport, BASE);

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ files: { "a.js": "1" } });
    expect(body).not.toHaveProperty("entrypoint");
    expect(body).not.toHaveProperty("runtime");
  });

  it("URL-encodes the sandbox name path segment", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(deployResponse()),
    ]);

    await deploy(
      { name: "weird name/x", files: { "a.js": "1" } },
      transport,
      BASE,
    );
    expect(calls[0]!.url).toBe(`${BASE}/v1/sandboxes/weird%20name%2Fx/deploy`);
  });

  it("surfaces a null url when previews are disabled gateway-side", async () => {
    const { transport } = makeTransport([
      () => jsonResponse(deployResponse({ url: null })),
    ]);

    const result = await deploy(
      { name: "my-api", files: { "a.js": "1" } },
      transport,
      BASE,
    );
    expect(result.url).toBeNull();
  });

  it("throws SandboxHttpError (with status) on a non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("not deployable", { status: 409 }),
    ]);

    await expect(
      deploy({ name: "my-api", files: { "a.js": "1" } }, transport, BASE),
    ).rejects.toMatchObject({ name: "SandboxHttpError", status: 409 });
  });

  it("Sandbox.deploy delegates to the module fn with the handle's name", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(deployResponse()),
    ]);
    const box = Sandbox.attach("my-api", { baseUrl: BASE }, transport);

    await box.deploy({ files: { "a.js": "1" }, entrypoint: "node a.js" });

    expect(calls[0]!.url).toBe(`${BASE}/v1/sandboxes/my-api/deploy`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      files: { "a.js": "1" },
      entrypoint: "node a.js",
    });
  });
});

describe("createPreview()", () => {
  it("POSTs /v1/sandboxes/:name/previews wrapping spec, and normalizes the URL", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          metadata: { name: "my-preview" },
          spec: {
            url: "https://abc.preview.bl.run",
            port: 3000,
            status: "deployed",
            public: true,
          },
        }),
    ]);

    const result = await createPreview(
      { name: "my-api", port: 3000, previewName: "my-preview", public: true },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/sandboxes/my-api/previews`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      spec: { port: 3000, public: true },
      metadata: { name: "my-preview" },
    });

    // Nested spec/metadata shape is flattened.
    expect(result).toEqual({
      name: "my-preview",
      url: "https://abc.preview.bl.run",
      port: 3000,
      status: "deployed",
      public: true,
      prefixUrl: undefined,
      customDomain: undefined,
      label: undefined,
    });
  });

  it("normalizes a flat (non-nested) preview response", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          name: "p",
          url: "https://flat.preview",
          port: 8080,
          status: "ok",
        }),
    ]);

    const result = await createPreview(
      { name: "my-api", port: 8080 },
      transport,
      BASE,
    );
    expect(result.url).toBe("https://flat.preview");
    expect(result.name).toBe("p");
    expect(result.port).toBe(8080);
  });

  it("forwards prefixUrl/customDomain/label into spec and omits the metadata when no previewName", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ spec: { url: "https://my-app.polsia.app" } }),
    ]);

    await createPreview(
      {
        name: "my-api",
        port: 3000,
        prefixUrl: "my-app",
        customDomain: "polsia.app",
        label: "prod",
      },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({
      spec: {
        port: 3000,
        prefixUrl: "my-app",
        customDomain: "polsia.app",
        label: "prod",
      },
    });
    expect(body).not.toHaveProperty("metadata");
  });

  it("throws SandboxHttpError on a non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("nope", { status: 402 }),
    ]);

    await expect(
      createPreview({ name: "my-api", port: 3000 }, transport, BASE),
    ).rejects.toMatchObject({ name: "SandboxHttpError", status: 402 });
  });

  it("Sandbox.createPreview delegates to the module fn with the handle's name", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ spec: { url: "https://x.preview", port: 3000 } }),
    ]);
    const box = Sandbox.attach("my-api", { baseUrl: BASE }, transport);

    const result = await box.createPreview({ port: 3000 });
    expect(calls[0]!.url).toBe(`${BASE}/v1/sandboxes/my-api/previews`);
    expect(result.url).toBe("https://x.preview");
  });
});

describe("sandboxes — client wiring + credential", () => {
  it("createClient().sandboxes.deploy / .createPreview route with the credential", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init });
      if (url.endsWith("/deploy")) return jsonResponse(deployResponse());
      return jsonResponse({ spec: { url: "https://p.preview", port: 3000 } });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "my-key", fetch: fetchMock });
    await sapiom.sandboxes.deploy({ name: "my-api", files: { "a.js": "1" } });
    await sapiom.sandboxes.createPreview({ name: "my-api", port: 3000 });

    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }
    expect(calls[0]!.url).toBe(
      "https://blaxel.services.sapiom.ai/v1/sandboxes/my-api/deploy",
    );
  });
});
