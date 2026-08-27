/**
 * `sapiom_dev_app_publish` — the tool's contract with the agent calling it.
 *
 * The backend is mocked at `fetch` (this is the only tool that speaks to the
 * App Links REST API directly), so the assertions that matter are the ones a
 * consumer depends on: the three-call ORDER, the durability wording the
 * routing decision hangs on, the wire-code → actionable-error mapping, and that
 * a binary file is rejected by name with no HTTP call at all.
 */
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { z } from "zod";

import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({ readCredentials: vi.fn() }));

import { readCredentials } from "../credentials.js";
import { register } from "./app-publish.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface Registration {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: ToolHandler;
}

function createMockServer(): {
  server: McpServer;
  registrations: Map<string, Registration>;
} {
  const registrations = new Map<string, Registration>();
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: Record<string, z.ZodTypeAny>,
        handler: ToolHandler,
      ) => {
        registrations.set(name, { name, description, schema, handler });
      },
    ),
  } as unknown as McpServer;
  return { server, registrations };
}

const TOOL = "sapiom_dev_app_publish";

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

const SANDBOX = {
  type: "sandbox",
  source: { kind: "upload" },
  build: "npm install",
  start: "node server.js",
  port: 3000,
  env: { API_TOKEN: "t" },
};

const APP_LINK = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "dash",
  name: "Dash",
  visibility: "organization",
  url: "https://apps.sapiom.ai/acme/dash",
};

const BUNDLE = {
  bundleSha256: "abc123",
  manifest: {
    start: "node server.js",
    port: 3000,
    build: "npm install",
    envKeys: ["API_TOKEN"],
    fileCount: 1,
    bytes: 42,
  },
};

const parse = (res: { content: Array<{ text: string }> }) =>
  JSON.parse(res.content[0].text);

function setup(): Registration {
  const { server, registrations } = createMockServer();
  register(server, env);
  return registrations.get(TOOL)!;
}

/** A project dir with one sandbox resource and `files` under the source root. */
function tmpProject(
  files: Record<string, string | Uint8Array> = { "index.html": "<h1>hi</h1>" },
  sandbox: Record<string, unknown> = SANDBOX,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "app-publish-"));
  writeFileSync(
    path.join(dir, "sapiom.json"),
    JSON.stringify({ version: 1, resources: { web: sandbox } }),
  );
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return dir;
}

/** JSON response for the next fetch call. */
const jsonRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "",
  text: () => Promise.resolve(JSON.stringify(body)),
});

/** The happy-path backend: upsert → bundle → publish. */
function mockHappyBackend(): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonRes(APP_LINK, 201))
    .mockResolvedValueOnce(jsonRes(BUNDLE))
    .mockResolvedValueOnce(jsonRes(APP_LINK));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

/**
 * Play the happy responses up to `step`, then fail it. Fire-on-every-call
 * mocking would land every case on call #1 and never exercise the
 * link-already-created path that the error copy has to be honest about.
 */
const STEP_INDEX = { create: 0, bundle: 1, publish: 2 } as const;

function mockBackendErrorAt(
  step: keyof typeof STEP_INDEX,
  body: unknown,
  status: number,
): ReturnType<typeof vi.fn> {
  const happy = [jsonRes(APP_LINK, 201), jsonRes(BUNDLE), jsonRes(APP_LINK)];
  const fetchMock = vi.fn();
  for (const res of happy.slice(0, STEP_INDEX[step])) {
    fetchMock.mockResolvedValueOnce(res);
  }
  fetchMock.mockResolvedValue(jsonRes(body, status));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

describe("sapiom_dev_app_publish tool", () => {
  let originalFetch: typeof globalThis.fetch;
  const dirs: string[] = [];

  const project = (...args: Parameters<typeof tmpProject>): string => {
    const dir = tmpProject(...args);
    dirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
    vi.mocked(readCredentials).mockResolvedValue({
      apiKey: "sk_test",
      tenantId: "t-1",
      organizationName: "Acme",
      apiKeyId: "k-1",
    } as never);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("registers under the documented name", () => {
    expect(setup().name).toBe(TOOL);
  });

  it("routes durability asks to itself: the description names what a preview URL cannot do", () => {
    const { description } = setup();
    expect(description).toMatch(/durable/i);
    expect(description).toMatch(/permanent/i);
    expect(description).toMatch(/shareable/i);
    expect(description).toMatch(/expires with the sandbox/i);
    // Cold start, org-scoping, republish-in-place, text-only, and the REST cap:
    // the five facts an agent gets wrong if the description omits them.
    expect(description).toMatch(/cold-start/i);
    expect(description).toMatch(/org-scoped by default/i);
    expect(description).toMatch(/same slug again replaces the app in place/i);
    expect(description).toMatch(/TEXT-ONLY/);
    expect(description).toMatch(/10 MiB/);
  });

  it("is not authenticated without a cached credential, and makes no call", async () => {
    vi.mocked(readCredentials).mockResolvedValue(null);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const res = await setup().handler({
      dir: project(),
      slug: "dash",
      name: "Dash",
    });

    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe("NOT_AUTHENTICATED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls upsert → bundle → publish in order, authed with x-api-key", async () => {
    const fetchMock = mockHappyBackend();
    const dir = project({ "index.html": "<h1>hi</h1>", "src/app.js": "1;" });

    const res = await setup().handler({ dir, slug: "dash", name: "Dash" });

    expect(res.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [upsertUrl, upsertInit] = fetchMock.mock.calls[0];
    expect(upsertUrl).toBe("https://api.sapiom.ai/v1/app-links");
    expect(upsertInit.method).toBe("POST");
    expect(upsertInit.headers["x-api-key"]).toBe("sk_test");
    expect(JSON.parse(upsertInit.body)).toEqual({
      slug: "dash",
      name: "Dash",
      // The resource's env travels with the app; `tier`/`ttl` deliberately do not.
      env: { API_TOKEN: "t" },
    });

    const [bundleUrl, bundleInit] = fetchMock.mock.calls[1];
    expect(bundleUrl).toBe(
      `https://api.sapiom.ai/v1/app-links/${APP_LINK.id}/bundle`,
    );
    expect(bundleInit.method).toBe("PUT");
    expect(JSON.parse(bundleInit.body)).toEqual({
      files: { "index.html": "<h1>hi</h1>", "src/app.js": "1;" },
      start: "node server.js",
      port: 3000,
      build: "npm install",
    });

    const [publishUrl, publishInit] = fetchMock.mock.calls[2];
    expect(publishUrl).toBe(
      `https://api.sapiom.ai/v1/app-links/${APP_LINK.id}/publish`,
    );
    expect(publishInit.method).toBe("POST");
    // The activate route takes no body — it activates the bundle just stored.
    expect(JSON.parse(publishInit.body)).toEqual({});
  });

  it("keeps a base path on a custom apiURL instead of dropping it", async () => {
    const { server, registrations } = createMockServer();
    register(server, { ...env, apiURL: "http://localhost:3000/api/" });
    const fetchMock = mockHappyBackend();

    await registrations.get(TOOL)!.handler({
      dir: project(),
      slug: "dash",
      name: "Dash",
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost:3000/api/v1/app-links",
    );
  });

  it("reports the sha the backend says is active, and flags it when that is not ours", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(APP_LINK, 201))
      .mockResolvedValueOnce(jsonRes(BUNDLE))
      .mockResolvedValueOnce(
        jsonRes({ ...APP_LINK, bundleSha256: "raced99" }),
      ) as unknown as typeof globalThis.fetch;

    const res = await setup().handler({
      dir: project(),
      slug: "dash",
      name: "Dash",
    });

    const payload = parse(res);
    expect(payload.bundleSha256).toBe("raced99");
    // `manifest` describes OUR upload, so a foreign live sha cannot be reported
    // beside it as if it matched.
    expect(payload.warning).toContain("abc123");
    expect(payload.warning).toContain("raced99");
    expect(payload.summary).toContain("see `warning`");
  });

  it("says nothing about a race when the active sha is the one we uploaded", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(APP_LINK, 201))
      .mockResolvedValueOnce(jsonRes(BUNDLE))
      .mockResolvedValueOnce(
        jsonRes({ ...APP_LINK, bundleSha256: "abc123" }),
      ) as unknown as typeof globalThis.fetch;

    const res = await setup().handler({
      dir: project(),
      slug: "dash",
      name: "Dash",
    });

    const payload = parse(res);
    expect(payload.warning).toBeUndefined();
    expect(payload.summary).toContain("1 files");
  });

  it("skips a symlink rather than publishing what it points at", async () => {
    const fetchMock = mockHappyBackend();
    const dir = project({ "index.html": "<h1>hi</h1>" });
    // The hazard: a bundle can end up behind a public URL, so following a link
    // out of the source tree would publish whatever is on the other end.
    writeFileSync(path.join(dir, "..", "app-publish-secret.txt"), "SECRET");
    symlinkSync(
      path.join(dir, "..", "app-publish-secret.txt"),
      path.join(dir, "leak.txt"),
    );
    symlinkSync(dir, path.join(dir, "loop"));

    const res = await setup().handler({ dir, slug: "dash", name: "Dash" });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).files).toEqual({
      "index.html": "<h1>hi</h1>",
    });
    rmSync(path.join(dir, "..", "app-publish-secret.txt"), { force: true });
  });

  it("keeps a nested sapiom.json — only the project's own is config", async () => {
    const fetchMock = mockHappyBackend();
    const dir = project({
      "index.html": "<h1>hi</h1>",
      "fixtures/sapiom.json": '{"sample":true}',
    });

    await setup().handler({ dir, slug: "dash", name: "Dash" });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).files).toEqual({
      "index.html": "<h1>hi</h1>",
      "fixtures/sapiom.json": '{"sample":true}',
    });
  });

  it("refuses an over-cap bundle locally, before any HTTP call", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const dir = project({ "big.txt": "x".repeat(10 * 1024 * 1024 + 1) });

    const res = await setup().handler({ dir, slug: "dash", name: "Dash" });

    expect(res.isError).toBe(true);
    const { error } = parse(res);
    expect(error.code).toBe("BUNDLE_TOO_LARGE");
    expect(error.message).toContain("Nothing was created or published.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the durable url, ids and manifest plus a one-line summary", async () => {
    mockHappyBackend();
    const res = await setup().handler({
      dir: project(),
      slug: "dash",
      name: "Dash",
    });

    const payload = parse(res);
    expect(payload).toMatchObject({
      url: "https://apps.sapiom.ai/acme/dash",
      appLinkId: APP_LINK.id,
      bundleSha256: "abc123",
      manifest: BUNDLE.manifest,
    });
    expect(payload.summary).toContain("https://apps.sapiom.ai/acme/dash");
    expect(payload.summary).toMatch(/durable/i);
    expect(payload.summary.split("\n")).toHaveLength(1);
  });

  it("forwards the optional metadata a public app needs", async () => {
    const fetchMock = mockHappyBackend();
    await setup().handler({
      dir: project(),
      slug: "dash",
      name: "Dash",
      description: "The dash",
      visibility: "public",
      confirmPublic: true,
      dailySpendCapUsd: "5.00",
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      slug: "dash",
      name: "Dash",
      description: "The dash",
      visibility: "public",
      confirmPublic: true,
      dailySpendCapUsd: "5.00",
      env: { API_TOKEN: "t" },
    });
  });

  it("never bundles sapiom.json — its env block is the app's own secrets", async () => {
    const fetchMock = mockHappyBackend();
    const dir = project({ "index.html": "<h1>hi</h1>" });

    await setup().handler({ dir, slug: "dash", name: "Dash" });

    const { files } = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(files).toEqual({ "index.html": "<h1>hi</h1>" });
  });

  it("skips node_modules, .git and dotfiles, and reads a nested source path", async () => {
    const fetchMock = mockHappyBackend();
    const dir = project(
      {
        "web/index.html": "<h1>hi</h1>",
        "web/node_modules/left-pad/index.js": "module.exports=1",
        "web/.env": "SECRET=1",
        "web/.git/config": "[core]",
        "outside.txt": "not part of the app",
      },
      { ...SANDBOX, source: { kind: "upload", path: "web" } },
    );

    await setup().handler({ dir, slug: "dash", name: "Dash" });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).files).toEqual({
      "index.html": "<h1>hi</h1>",
    });
  });

  it("names a binary file and publishes nothing — before any HTTP call", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const dir = project({
      "index.html": "<h1>hi</h1>",
      "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]),
    });

    const res = await setup().handler({ dir, slug: "dash", name: "Dash" });

    expect(res.isError).toBe(true);
    const { error } = parse(res);
    expect(error.code).toBe("BUNDLE_BINARY_FILE");
    expect(error.message).toContain("logo.png");
    expect(error.hint).toContain("logo.png");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing sandbox resource without touching the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const dir = mkdtempSync(path.join(tmpdir(), "app-publish-empty-"));
    dirs.push(dir);
    writeFileSync(
      path.join(dir, "sapiom.json"),
      JSON.stringify({ version: 1 }),
    );

    const res = await setup().handler({ dir, slug: "dash", name: "Dash" });

    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe("NO_SANDBOX");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty source directory before uploading", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const dir = project({ ".hidden": "skipped" });

    const res = await setup().handler({ dir, slug: "dash", name: "Dash" });

    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe("BUNDLE_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("wire error mapping", () => {
    const cases: Array<{
      label: string;
      step: keyof typeof STEP_INDEX;
      body: Record<string, unknown>;
      status: number;
      code: string;
      expect: RegExp;
    }> = [
      {
        label: "BUNDLE_BINARY_FILE names the file",
        step: "bundle",
        body: {
          code: "BUNDLE_BINARY_FILE",
          message: "nope",
          path: "assets/font.woff",
        },
        status: 400,
        code: "BUNDLE_BINARY_FILE",
        expect: /assets\/font\.woff/,
      },
      {
        label: "BUNDLE_TOO_LARGE quotes both sizes",
        step: "bundle",
        body: {
          code: "BUNDLE_TOO_LARGE",
          message: "too big",
          bytes: 20_000_000,
          maxBytes: 10_485_760,
        },
        status: 400,
        code: "BUNDLE_TOO_LARGE",
        expect: /20000000 bytes exceeds the 10485760-byte limit/,
      },
      {
        label: "PUBLIC_CONFIRM_REQUIRED asks for the acknowledgement",
        step: "create",
        body: { code: "PUBLIC_CONFIRM_REQUIRED", message: "confirm" },
        status: 409,
        code: "PUBLIC_CONFIRM_REQUIRED",
        expect: /anyone with the link/i,
      },
      {
        label: "PUBLIC_SPEND_CAP_REQUIRED asks for the cap",
        step: "create",
        body: { code: "PUBLIC_SPEND_CAP_REQUIRED", message: "cap" },
        status: 400,
        code: "PUBLIC_SPEND_CAP_REQUIRED",
        expect: /daily spend cap/i,
      },
      {
        label: "a management-permission 403 says to drop the management fields",
        step: "create",
        body: {
          code: "APP_LINK_MANAGEMENT_PERMISSION_REQUIRED",
          message:
            "Changing visibility on an existing app link requires org.write.",
        },
        status: 403,
        code: "APP_LINK_MANAGEMENT_PERMISSION_REQUIRED",
        expect: /Republish without the management fields/,
      },
      {
        label: "401 points at re-authentication",
        step: "create",
        body: { message: "Unauthorized" },
        status: 401,
        code: "NOT_AUTHENTICATED",
        expect: /401/,
      },
      {
        label: "403 names the missing permission",
        step: "create",
        body: { message: "Missing required permission" },
        status: 403,
        code: "FORBIDDEN",
        expect: /403/,
      },
    ];

    for (const c of cases) {
      it(c.label, async () => {
        mockBackendErrorAt(c.step, c.body, c.status);
        const res = await setup().handler({
          dir: project(),
          slug: "dash",
          name: "Dash",
        });

        expect(res.isError).toBe(true);
        const { error } = parse(res);
        expect(error.code).toBe(c.code);
        expect(`${error.message} ${error.hint ?? ""}`).toMatch(c.expect);
        // The state the agent is left in, per step. Claiming "nothing was
        // created" after the upsert already created the link is the one thing
        // this copy must never do.
        if (c.step === "create") {
          expect(error.message).toContain("Nothing was created or published.");
        } else {
          expect(error.message).toContain('The "dash" app link EXISTS');
        }
      });
    }

    it("403 hint names org.app_links.publish", async () => {
      mockBackendErrorAt("create", { message: "no" }, 403);
      const res = await setup().handler({
        dir: project(),
        slug: "dash",
        name: "Dash",
      });
      expect(parse(res).error.hint).toContain("org.app_links.publish");
    });

    it("falls back to HTTP_<status> for an unmapped failure", async () => {
      mockBackendErrorAt("create", { message: "boom" }, 500);
      const res = await setup().handler({
        dir: project(),
        slug: "dash",
        name: "Dash",
      });
      expect(parse(res).error.code).toBe("HTTP_500");
    });

    it("a failure at activate still says the link exists and needs finishing", async () => {
      const fetchMock = mockBackendErrorAt(
        "publish",
        { code: "NO_BUNDLE", message: "no bundle" },
        409,
      );
      const res = await setup().handler({
        dir: project(),
        slug: "dash",
        name: "Dash",
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const { error } = parse(res);
      expect(error.code).toBe("NO_BUNDLE");
      expect(error.message).toContain('The "dash" app link EXISTS');
      expect(error.message).toContain("publish the same slug again");
      expect(error.message).not.toContain("Nothing was");
      expect(error.step).toBe("POST /v1/app-links/{id}/publish");
    });

    it("an unreachable backend mid-flow does not claim nothing was created", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonRes(APP_LINK, 201))
        .mockRejectedValue(new Error("ECONNRESET"));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const res = await setup().handler({
        dir: project(),
        slug: "dash",
        name: "Dash",
      });

      const { error } = parse(res);
      expect(error.code).toBe("NETWORK");
      expect(error.message).toContain('The "dash" app link EXISTS');
    });

    it("refuses a 2xx body that is not an app link instead of addressing /undefined/", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "",
        text: () => Promise.resolve("<html>gateway</html>"),
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const res = await setup().handler({
        dir: project(),
        slug: "dash",
        name: "Dash",
      });

      expect(res.isError).toBe(true);
      expect(parse(res).error.code).toBe("UNEXPECTED_RESPONSE");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("maps an unreachable backend to NETWORK", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(
          new Error("ECONNREFUSED"),
        ) as unknown as typeof globalThis.fetch;
      const res = await setup().handler({
        dir: project(),
        slug: "dash",
        name: "Dash",
      });
      const { error } = parse(res);
      expect(error.code).toBe("NETWORK");
      expect(error.hint).toContain("ECONNREFUSED");
      expect(error.message).toContain("Nothing was created or published.");
    });
  });

  it("republishing the same slug keeps the URL and reports the new sha", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(APP_LINK, 201))
      .mockResolvedValueOnce(jsonRes({ ...BUNDLE, bundleSha256: "def456" }))
      .mockResolvedValueOnce(
        jsonRes(APP_LINK),
      ) as unknown as typeof globalThis.fetch;

    const res = await setup().handler({
      dir: project({ "index.html": "<h1>changed</h1>" }),
      slug: "dash",
      name: "Dash",
    });

    expect(parse(res)).toMatchObject({
      url: APP_LINK.url,
      bundleSha256: "def456",
    });
  });
});
