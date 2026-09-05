/**
 * `sapiom_dev_app_list` / `_settings` / `_delete` — the tools' contract with the
 * agent calling them.
 *
 * The backend is mocked at `fetch`. What matters to a consumer: the routes and
 * bodies each tool sends (only the fields asked for; nothing else), that a slug
 * resolves through the list route, and — the point of the ticket — that a 403
 * comes back as a sentence naming the permission and the fields, never as a
 * status the agent might retry or a silent success.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { z } from "zod";

import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({ readCredentials: vi.fn() }));

import { readCredentials } from "../credentials.js";
import { register } from "./app-manage.js";

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

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

const DASH = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "dash",
  name: "Dash",
  visibility: "organization",
  url: "https://apps.sapiom.ai/acme/dash",
  webhooksEnabled: false,
  wakeRateLimitPerHour: 60,
  dailySpendCapUsd: null,
  wakeStatus: "idle",
  bundleSha256: "abc123",
  updatedAt: "2026-09-04T10:00:00.000Z",
};

const HOOKS = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "hooks",
  name: "Hooks",
  visibility: "organization",
  url: "https://apps.sapiom.ai/acme/hooks",
  webhooksEnabled: true,
  wakeRateLimitPerHour: 60,
  dailySpendCapUsd: "5.00",
  wakeStatus: "ready",
  bundleSha256: null,
  updatedAt: "2026-09-04T11:00:00.000Z",
};

const parse = (res: { content: Array<{ text: string }> }) =>
  JSON.parse(res.content[0].text);

function setup(): Map<string, Registration> {
  const { server, registrations } = createMockServer();
  register(server, env);
  return registrations;
}

const tool = (name: string) => setup().get(name)!;

/** JSON response for one fetch call. */
const jsonRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "",
  text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
});

/** Queue responses in call order; the last one repeats. */
function mockBackend(...responses: ReturnType<typeof jsonRes>[]) {
  const fetchMock = vi.fn();
  for (const res of responses) fetchMock.mockResolvedValueOnce(res);
  fetchMock.mockResolvedValue(responses[responses.length - 1]);
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

const call = (fetchMock: ReturnType<typeof vi.fn>, n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : JSON.parse(init.body as string),
  };
};

/** The 403 the route-level `PermissionGuard` produces (no App Links `code`). */
const ROUTE_403 = jsonRes(
  {
    statusCode: 403,
    message: "Missing required permissions: org.write",
    error: "Forbidden",
  },
  403,
);

describe("App Link management tools", () => {
  let originalFetch: typeof globalThis.fetch;

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
  });

  it("registers the three documented names", () => {
    expect([...setup().keys()].sort()).toEqual([
      "sapiom_dev_app_delete",
      "sapiom_dev_app_list",
      "sapiom_dev_app_settings",
    ]);
  });

  it("every tool returns the structured not-authenticated error with no HTTP call", async () => {
    vi.mocked(readCredentials).mockResolvedValue(null);
    const fetchMock = mockBackend(jsonRes({}));
    for (const [name, args] of [
      ["sapiom_dev_app_list", {}],
      ["sapiom_dev_app_settings", { slug: "dash", webhooksEnabled: true }],
      ["sapiom_dev_app_delete", { slug: "dash", confirm: true }],
    ] as const) {
      const res = await tool(name).handler({ ...args });
      expect(res.isError, name).toBe(true);
      expect(parse(res).error.code, name).toBe("NOT_AUTHENTICATED");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ─── list ──────────────────────────────────────────────────────────────────

  describe("sapiom_dev_app_list", () => {
    it("GETs /v1/app-links with the cached key and reports each link's exposure", async () => {
      const fetchMock = mockBackend(jsonRes({ items: [DASH, HOOKS] }));
      const res = await tool("sapiom_dev_app_list").handler({});

      expect(res.isError).toBeUndefined();
      const c = call(fetchMock, 0);
      expect(c.method).toBe("GET");
      expect(c.url).toBe("https://api.sapiom.ai/v1/app-links");
      expect(c.headers["x-api-key"]).toBe("sk_test");
      expect(c.body).toBeUndefined();

      const out = parse(res);
      expect(out.count).toBe(2);
      expect(out.links[0]).toMatchObject({
        slug: "dash",
        url: DASH.url,
        appLinkId: DASH.id,
        webhooksEnabled: false,
        webhookUrl: null,
        published: true,
      });
      // The /hook URL is spelled out only where it is live.
      expect(out.links[1]).toMatchObject({
        slug: "hooks",
        webhooksEnabled: true,
        webhookUrl: "https://apps.sapiom.ai/acme/hooks/hook/",
        dailySpendCapUsd: "5.00",
        published: false,
      });
      expect(out.summary).toContain("2 App Links");
    });

    it("says so, and where to publish, when the organization has none", async () => {
      mockBackend(jsonRes({ items: [] }));
      const out = parse(await tool("sapiom_dev_app_list").handler({}));
      expect(out.count).toBe(0);
      expect(out.summary).toContain("sapiom_dev_app_publish");
    });

    it("a 403 names org.read rather than surfacing the status", async () => {
      mockBackend(
        jsonRes(
          {
            statusCode: 403,
            message: "Missing required permissions: org.read",
          },
          403,
        ),
      );
      const res = await tool("sapiom_dev_app_list").handler({});
      expect(res.isError).toBe(true);
      const { error } = parse(res);
      expect(error.code).toBe("PERMISSION_REQUIRED");
      expect(error.message).toContain("`org.read`");
    });

    it("a success body that is not a list is an UNEXPECTED_RESPONSE, not a crash", async () => {
      mockBackend(jsonRes("<html>proxy</html>"));
      const res = await tool("sapiom_dev_app_list").handler({});
      expect(res.isError).toBe(true);
      expect(parse(res).error.code).toBe("UNEXPECTED_RESPONSE");
    });
  });

  // ─── settings ──────────────────────────────────────────────────────────────

  describe("sapiom_dev_app_settings", () => {
    it("resolves the slug through the list, then PATCHes only the fields given", async () => {
      const fetchMock = mockBackend(
        jsonRes({ items: [DASH, HOOKS] }),
        jsonRes({ ...DASH, webhooksEnabled: true }),
      );
      const res = await tool("sapiom_dev_app_settings").handler({
        slug: "dash",
        webhooksEnabled: true,
      });

      expect(res.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(call(fetchMock, 0)).toMatchObject({
        method: "GET",
        url: "https://api.sapiom.ai/v1/app-links",
      });
      const patch = call(fetchMock, 1);
      expect(patch.method).toBe("PATCH");
      expect(patch.url).toBe(`https://api.sapiom.ai/v1/app-links/${DASH.id}`);
      // Nothing the caller did not ask for — no visibility, no cap, no name.
      expect(patch.body).toEqual({ webhooksEnabled: true });

      const out = parse(res);
      expect(out.changed).toEqual(["webhooksEnabled"]);
      expect(out.webhookUrl).toBe("https://apps.sapiom.ai/acme/dash/hook/");
      expect(out.settings.webhooksEnabled).toBe(true);
      // The acceptance path: the agent can hand this straight to the user and
      // they know where the third party POSTs.
      expect(out.summary).toContain("Webhooks are ON");
      expect(out.summary).toContain("/hook/<path>");
    });

    it("skips the list when addressed by appLinkId (one direct GET; both paths need org.read)", async () => {
      const fetchMock = mockBackend(
        jsonRes(DASH),
        jsonRes({ ...DASH, webhooksEnabled: true }),
      );
      const res = await tool("sapiom_dev_app_settings").handler({
        appLinkId: DASH.id,
        webhooksEnabled: true,
      });
      expect(res.isError).toBeUndefined();
      expect(call(fetchMock, 0)).toMatchObject({
        method: "GET",
        url: `https://api.sapiom.ai/v1/app-links/${DASH.id}`,
      });
      expect(call(fetchMock, 1).method).toBe("PATCH");
    });

    it("a 2xx PATCH body that is not a link is UNEXPECTED_RESPONSE, never a report of the old state", async () => {
      // Falling back to the pre-change link would answer "Webhooks are OFF" to a
      // request that asked to turn them on — a self-contradicting success.
      for (const body of [
        jsonRes(undefined, 204),
        jsonRes("<html>proxy</html>"),
      ]) {
        mockBackend(jsonRes({ items: [DASH] }), body);
        const res = await tool("sapiom_dev_app_settings").handler({
          slug: "dash",
          webhooksEnabled: true,
        });
        expect(res.isError).toBe(true);
        const { error } = parse(res);
        expect(error.code).toBe("UNEXPECTED_RESPONSE");
        expect(error.message).toContain("webhooksEnabled");
        expect(error.message).toContain("unknown");
        expect(error.hint).toContain("sapiom_dev_app_list");
      }
    });

    it("forwards confirmPublic alongside a public flip, and reports the audience change", async () => {
      const fetchMock = mockBackend(
        jsonRes({ items: [DASH] }),
        jsonRes({ ...DASH, visibility: "public", dailySpendCapUsd: "5.00" }),
      );
      const res = await tool("sapiom_dev_app_settings").handler({
        slug: "dash",
        visibility: "public",
        confirmPublic: true,
        dailySpendCapUsd: "5.00",
      });
      expect(res.isError).toBeUndefined();
      expect(call(fetchMock, 1).body).toEqual({
        visibility: "public",
        confirmPublic: true,
        dailySpendCapUsd: "5.00",
      });
      const out = parse(res);
      expect(out.changed).toEqual(["visibility", "dailySpendCapUsd"]);
      expect(out.summary).toContain("PUBLIC");
      expect(out.summary).toContain("$5.00");
    });

    it("sends dailySpendCapUsd: null to clear the cap", async () => {
      const fetchMock = mockBackend(
        jsonRes({ items: [HOOKS] }),
        jsonRes({ ...HOOKS, dailySpendCapUsd: null }),
      );
      const res = await tool("sapiom_dev_app_settings").handler({
        slug: "hooks",
        dailySpendCapUsd: null,
      });
      expect(res.isError).toBeUndefined();
      expect(call(fetchMock, 1).body).toEqual({ dailySpendCapUsd: null });
      expect(parse(res).summary).toContain("cap is cleared");
    });

    it("refuses an empty change without any HTTP call", async () => {
      const fetchMock = mockBackend(jsonRes({}));
      const res = await tool("sapiom_dev_app_settings").handler({
        slug: "dash",
      });
      expect(res.isError).toBe(true);
      expect(parse(res).error.code).toBe("NO_SETTINGS");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("requires slug or appLinkId", async () => {
      const fetchMock = mockBackend(jsonRes({}));
      const res = await tool("sapiom_dev_app_settings").handler({
        webhooksEnabled: true,
      });
      expect(res.isError).toBe(true);
      expect(parse(res).error.code).toBe("TARGET_REQUIRED");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("an unknown slug is APP_LINK_NOT_FOUND, pointing at the list tool", async () => {
      const fetchMock = mockBackend(jsonRes({ items: [DASH] }));
      const res = await tool("sapiom_dev_app_settings").handler({
        slug: "nope",
        webhooksEnabled: true,
      });
      expect(res.isError).toBe(true);
      const { error } = parse(res);
      expect(error.code).toBe("APP_LINK_NOT_FOUND");
      expect(error.message).toContain('"nope"');
      expect(error.hint).toContain("sapiom_dev_app_list");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("the route-level 403 becomes a sentence naming org.write and the fields (acceptance)", async () => {
      mockBackend(jsonRes({ items: [DASH] }), ROUTE_403);
      const res = await tool("sapiom_dev_app_settings").handler({
        slug: "dash",
        webhooksEnabled: true,
        wakeRateLimitPerHour: 10,
      });
      expect(res.isError).toBe(true);
      const { error } = parse(res);
      expect(error.code).toBe("PERMISSION_REQUIRED");
      expect(error.message).toContain("`org.write`");
      expect(error.message).toContain("webhooksEnabled, wakeRateLimitPerHour");
      expect(error.message).toContain("Nothing was changed");
      // The agent is told to relay, not retry, and what publish authority can do.
      expect(error.hint).toContain("Tell the user");
      expect(error.hint).toContain("org.app_links.publish");
      // Not a stack, not a bare status.
      expect(error.message).not.toMatch(/^403/);
      expect(JSON.stringify(error)).not.toContain("Forbidden");
    });

    it("keeps the service-level management code when the backend sends it", async () => {
      mockBackend(
        jsonRes({ items: [DASH] }),
        jsonRes(
          {
            statusCode: 403,
            code: "APP_LINK_MANAGEMENT_PERMISSION_REQUIRED",
            message:
              "Changing visibility on an existing app link requires the org.write permission.",
          },
          403,
        ),
      );
      const res = await tool("sapiom_dev_app_settings").handler({
        slug: "dash",
        visibility: "public",
        confirmPublic: true,
        dailySpendCapUsd: "1.00",
      });
      const { error } = parse(res);
      expect(error.code).toBe("APP_LINK_MANAGEMENT_PERMISSION_REQUIRED");
      expect(error.message).toContain("`org.write`");
      expect(error.message).toContain("visibility, dailySpendCapUsd");
    });

    it("maps PUBLIC_CONFIRM_REQUIRED and PUBLIC_SPEND_CAP_REQUIRED to the next move", async () => {
      mockBackend(
        jsonRes({ items: [DASH] }),
        jsonRes({ code: "PUBLIC_CONFIRM_REQUIRED", message: "confirm" }, 409),
      );
      let res = await tool("sapiom_dev_app_settings").handler({
        slug: "dash",
        visibility: "public",
      });
      expect(parse(res).error.code).toBe("PUBLIC_CONFIRM_REQUIRED");
      expect(parse(res).error.hint).toContain("confirmPublic: true");

      mockBackend(
        jsonRes({ items: [DASH] }),
        jsonRes({ code: "PUBLIC_SPEND_CAP_REQUIRED", message: "cap" }, 400),
      );
      res = await tool("sapiom_dev_app_settings").handler({
        slug: "dash",
        visibility: "public",
        confirmPublic: true,
      });
      expect(parse(res).error.code).toBe("PUBLIC_SPEND_CAP_REQUIRED");
      expect(parse(res).error.hint).toContain("dailySpendCapUsd");
    });

    it("a 401 says to re-authenticate", async () => {
      mockBackend(jsonRes({ message: "Invalid API key" }, 401));
      const res = await tool("sapiom_dev_app_settings").handler({
        slug: "dash",
        webhooksEnabled: true,
      });
      const { error } = parse(res);
      expect(error.code).toBe("NOT_AUTHENTICATED");
      expect(error.hint).toContain("sapiom_authenticate");
    });

    it("a network failure is NETWORK and says nothing was changed", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      const res = await tool("sapiom_dev_app_settings").handler({
        appLinkId: DASH.id,
        webhooksEnabled: true,
      });
      const { error } = parse(res);
      expect(error.code).toBe("NETWORK");
      expect(error.message).toContain("Nothing was changed");
      expect(error.hint).toContain("ECONNREFUSED");
    });

    it("its description teaches the webhook facts and the permission rule", () => {
      const { description } = tool("sapiom_dev_app_settings");
      expect(description).toContain("OFF by default");
      expect(description).toContain("/hook/<path>");
      expect(description).toContain("org.write");
      expect(description).toContain("do not retry");
    });
  });

  // ─── delete ────────────────────────────────────────────────────────────────

  describe("sapiom_dev_app_delete", () => {
    it("resolves the slug, DELETEs by id, and reports the slug as free", async () => {
      const fetchMock = mockBackend(
        jsonRes({ items: [DASH, HOOKS] }),
        jsonRes(undefined, 204),
      );
      const res = await tool("sapiom_dev_app_delete").handler({
        slug: "hooks",
        confirm: true,
      });
      expect(res.isError).toBeUndefined();
      expect(call(fetchMock, 1)).toMatchObject({
        method: "DELETE",
        url: `https://api.sapiom.ai/v1/app-links/${HOOKS.id}`,
        body: undefined,
      });
      const out = parse(res);
      expect(out).toMatchObject({
        appLinkId: HOOKS.id,
        slug: "hooks",
        url: HOOKS.url,
      });
      expect(out.summary).toContain("no longer resolves");
      expect(out.summary).toContain("free to reuse");
    });

    it("refuses without confirm: true and makes no HTTP call", async () => {
      const fetchMock = mockBackend(jsonRes({}));
      for (const confirm of [false, undefined]) {
        const res = await tool("sapiom_dev_app_delete").handler({
          slug: "dash",
          confirm,
        });
        expect(res.isError).toBe(true);
        const { error } = parse(res);
        expect(error.code).toBe("CONFIRM_REQUIRED");
        expect(error.message).toContain("Nothing was deleted");
        expect(error.hint).toContain("confirm: true");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("the route-level 403 names org.write", async () => {
      mockBackend(jsonRes(DASH), ROUTE_403);
      const res = await tool("sapiom_dev_app_delete").handler({
        appLinkId: DASH.id,
        confirm: true,
      });
      expect(res.isError).toBe(true);
      const { error } = parse(res);
      expect(error.code).toBe("PERMISSION_REQUIRED");
      expect(error.message).toContain("`org.write`");
      expect(error.message).toContain('Deleting the "dash" app link');
      expect(error.hint).toContain("Tell the user");
    });

    it("a 404 on the DELETE (deleted in between) is APP_LINK_NOT_FOUND", async () => {
      mockBackend(
        jsonRes({ items: [DASH] }),
        jsonRes({ code: "APP_LINK_NOT_FOUND", message: "gone" }, 404),
      );
      const res = await tool("sapiom_dev_app_delete").handler({
        slug: "dash",
        confirm: true,
      });
      expect(parse(res).error.code).toBe("APP_LINK_NOT_FOUND");
    });
  });
});
