import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AssistantGrant } from "../core/assistant-access.js";
import { startServer } from "./index.js";
import {
  OpenCodeBridge,
  assistantUpstreams,
  type OpenCodeBridgeCredential,
} from "./opencode-bridge.js";

let grant: AssistantGrant | null;
let bridge: OpenCodeBridge;
let credential: OpenCodeBridgeCredential;
let origin: string;
let upstream: express.Express;
let changed: () => void;
const servers: Server[] = [];
async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
beforeEach(async () => {
  upstream = express();
  upstream.use(express.json());
  const apiURL = await listen(upstream);
  grant = {
    userId: "user",
    tenantId: "tenant",
    identityRevision: "identity",
    expiresAt: Date.now() + 60000,
    environment: {
      name: "test",
      appURL: apiURL,
      apiURL,
      services: { llm: apiURL },
      credentials: {
        apiKey: "sk_private_studio",
        tenantId: "tenant",
        organizationName: "Org",
        apiKeyId: "key",
      },
    },
  };
  bridge = new OpenCodeBridge({
    get: () => grant,
    subscribe: (listener) => {
      changed = listener;
      return () => {};
    },
  });
  credential = bridge.issue();
  const app = express();
  app.use("/opencode-runtime", bridge.router);
  origin = await listen(app);
});
afterEach(async () => {
  bridge.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});
function request(
  path = "llm/v2/openai/v1/chat/completions",
  init: RequestInit = {},
) {
  return fetch(`${origin}/opencode-runtime/${credential.id}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "browser-override", messages: [] }),
    ...init,
  });
}

describe("Studio OpenCode credential bridge", () => {
  it("injects the current Studio key and configured model without forwarding caller credentials", async () => {
    upstream.post("/v2/openai/v1/chat/completions", (req, res) => {
      expect(req.headers["x-sapiom-api-key"]).toBe("sk_private_studio");
      expect(req.headers["x-sapiom-model"]).toBe("smart");
      expect(req.body.model).toBe("smart");
      for (const header of [
        "authorization",
        "cookie",
        "x-harness-token",
        "x-api-key",
      ])
        expect(req.headers[header]).toBeUndefined();
      res.json({ ok: true });
    });
    const response = await request(undefined, {
      headers: {
        Authorization: `Bearer ${credential.token}`,
        Cookie: "browser-cookie",
        "X-Harness-Token": "browser-boot",
        "x-api-key": "attacker",
      },
    });
    expect(await response.json()).toEqual({ ok: true });
  });

  it("forwards the first SSE chunk before upstream completion and aborts on disconnect", async () => {
    let finish!: () => void;
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write("data: first\n\n");
      finish = () => res.end("data: last\n\n");
      res.once("close", disconnected);
    });
    const abort = new AbortController();
    const response = await request(undefined, { signal: abort.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "data: first\n\n",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    abort.abort();
    await closed;
    finish();
  });

  it("rejects browser auth, unknown destinations, wrong methods, and query overrides", async () => {
    expect(
      (
        await request(undefined, {
          headers: { "X-Harness-Token": "browser-boot" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "llm/v2/openai/v1/chat/completions?url=https://other.example",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request("llm/v2/openai/v1/chat/completions", {
          method: "GET",
          body: undefined,
        })
      ).status,
    ).toBe(400);
    expect((await request("https://other.example")).status).toBe(404);
    expect((await request("llm/v2/openai/v1/models")).status).toBe(404);
  });

  it("retains MCP transport headers but replaces credentials at its fixed endpoint", async () => {
    upstream.post("/v1/mcp", (req, res) => {
      expect(req.headers["x-api-key"]).toBe("sk_private_studio");
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers["mcp-session-id"]).toBe("mcp-session");
      expect(req.body).toEqual({ method: "initialize" });
      res.setHeader("mcp-session-id", "mcp-next");
      res.json({ result: true });
    });
    const response = await request("mcp", {
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "mcp-session-id": "mcp-session",
      },
      body: JSON.stringify({ method: "initialize" }),
    });
    expect(await response.json()).toEqual({ result: true });
    expect(response.headers.get("mcp-session-id")).toBe("mcp-next");
  });

  it("resumes a queued MCP result without repeating its tool call", async () => {
    let calls = 0;
    let callId: string | number | undefined;
    const cursors: unknown[] = [];
    upstream.all("/v1/mcp", (req, res) => {
      res.setHeader("mcp-session-id", "queued-session");
      if (req.method === "DELETE") {
        res.status(405).end();
        return;
      }
      if (req.method === "GET") {
        const cursor = req.header("last-event-id");
        if (!cursor) {
          res.status(405).end();
          return;
        }
        cursors.push(cursor);
        expect(req.header("mcp-session-id")).toBe("queued-session");
        expect(req.header("mcp-protocol-version")).toBe("2025-11-25");
        expect(req.header("x-api-key")).toBe("sk_private_studio");
        expect(req.header("authorization")).toBeUndefined();
        res.type("text/event-stream").end(
          `id: queued-result\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: callId,
            result: { content: [{ type: "text", text: "MCP_OK" }] },
          })}\n\n`,
        );
        return;
      }
      const { id, method } = req.body;
      if (method === "initialize") {
        res.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "queued-fixture", version: "1" },
          },
        });
      } else if (method === "tools/call") {
        calls++;
        callId = id;
        res.type("text/event-stream").end("id: queued-start\nretry: 10\ndata:\n\n");
      } else res.status(202).end();
    });
    expect(
      (await request("mcp", { method: "GET", body: undefined })).status,
    ).toBe(405);
    expect(
      (await request("mcp", { method: "DELETE", body: undefined })).status,
    ).toBe(405);
    const client = new Client({ name: "replay-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/opencode-runtime/${credential.id}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${credential.token}` } } },
    );
    try {
      await client.connect(transport);
      const result = await client.callTool(
        { name: "lookup", arguments: {} },
        undefined,
        { timeout: 3000 },
      );
      expect(result.content).toEqual([{ type: "text", text: "MCP_OK" }]);
      expect(cursors).toEqual(["queued-start"]);
      expect(calls).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("never forwards upstream error bodies or follows redirects with credentials", async () => {
    upstream.post("/v2/openai/v1/chat/completions", (_req, res) =>
      res.status(401).send("sk_private_studio"),
    );
    const response = await request();
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("sk_private_studio");
    upstream.get("/v1/mcp", (_req, res) =>
      res.redirect("https://other.example"),
    );
    expect(
      (await request("mcp", { method: "GET", body: undefined })).status,
    ).toBe(502);
  });

  it.each([
    [
      400,
      "invalid_request_error",
      "assistant_invalid_request",
      "The Assistant request was rejected as invalid.",
    ],
    [
      401,
      "authentication_error",
      "assistant_authentication_failed",
      "Studio credentials were rejected. Sign in again.",
    ],
    [
      403,
      "permission_error",
      "assistant_permission_denied",
      "The Assistant service denied this request.",
    ],
    [
      413,
      "invalid_request_error",
      "assistant_request_too_large",
      "The Assistant request is too large.",
    ],
    [
      429,
      "rate_limit_error",
      "assistant_rate_limited",
      "The Assistant service is rate limited.",
    ],
    [
      408,
      "upstream_error",
      "assistant_upstream_error",
      "The Assistant service request failed.",
    ],
    [
      409,
      "upstream_error",
      "assistant_upstream_error",
      "The Assistant service request failed.",
    ],
    [
      500,
      "server_error",
      "assistant_service_unavailable",
      "The Assistant service is temporarily unavailable.",
    ],
    [
      502,
      "server_error",
      "assistant_service_unavailable",
      "The Assistant service is temporarily unavailable.",
    ],
    [
      503,
      "server_error",
      "assistant_service_unavailable",
      "The Assistant service is temporarily unavailable.",
    ],
    [
      504,
      "server_error",
      "assistant_service_unavailable",
      "The Assistant service is temporarily unavailable.",
    ],
  ] as const)(
    "preserves and sanitizes upstream HTTP %i without model-response replay",
    async (status, type, code, message) => {
      let calls = 0;
      upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
        calls++;
        res
          .status(status)
          .set("x-private-upstream", "sk_private_studio")
          .send("credential=sk_private_studio");
      });
      const response = await request();
      expect(response.status).toBe(status);
      expect(response.headers.get("x-private-upstream")).toBeNull();
      expect(await response.json()).toEqual({
        error: { message, type, code },
      });
      expect(calls).toBe(1);
    },
  );

  it.each([
    [413, "13", "13"],
    [429, "17", "17"],
    [503, "Wed, 21 Oct 2099 07:28:00 GMT", "Wed, 21 Oct 2099 07:28:00 GMT"],
    [400, "19", null],
    [502, "23", null],
    [429, "1e3", null],
    [429, "-1", null],
    [413, "9007199254740992", null],
    [503, "Wednesday, 21-Oct-99 07:28:00 GMT", null],
    [503, "Wed, 21 Oct 2015 07:28:00 GMT", null],
  ] as const)(
    "for HTTP %i validates Retry-After %s before forwarding it",
    async (status, retryAfter, expected) => {
      upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
        res.status(status).set("Retry-After", retryAfter).end();
      });
      const response = await request();
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe(expected);
    },
  );

  it("returns a sanitized retryable service error when the upstream is unreachable", async () => {
    const unavailable = createServer();
    await new Promise<void>((resolve) =>
      unavailable.listen(0, "127.0.0.1", resolve),
    );
    const address = unavailable.address() as { port: number };
    await new Promise<void>((resolve, reject) =>
      unavailable.close((error) => (error ? reject(error) : resolve())),
    );
    grant!.environment.services.llm = `http://127.0.0.1:${address.port}`;

    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        message: "Assistant connection failed.",
        type: "server_error",
        code: "assistant_connection_failed",
      },
    });
  });

  it("returns structured JSON 413 through the assembled Studio middleware", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "studio-bridge-limit-"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const studio = await startServer({
      port: 0,
      bootToken: "synthetic-boot-token",
      telemetryOptIn: false,
      authMode: "disabled",
      adapters: {},
      stateRoot,
      launchDir: stateRoot,
      autoCreateSession: false,
      loadSystemPrompt: async () => "",
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${studio.port}/opencode-runtime/unknown/llm/v2/openai/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer synthetic-runtime-token",
            "Content-Type": "application/json",
          },
          body: "x".repeat(4 * 1024 * 1024 + 1),
        },
      );
      expect(response.status).toBe(413);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.json()).toEqual({
        error: {
          message: "Request body is too large.",
          type: "invalid_request_error",
          code: "request_body_too_large",
        },
      });
      expect(consoleError).toHaveBeenCalledWith(
        "[harness] request body too large",
      );
    } finally {
      await studio.close();
      await rm(stateRoot, { recursive: true, force: true });
      consoleError.mockRestore();
    }
  });

  it("revokes credentials and active streams on access loss, and permits a fresh login", async () => {
    upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write("data: first\n\n");
    });
    const response = await request();
    const reader = response.body!.getReader();
    await reader.read();
    const previous = grant!;
    grant = null;
    changed();
    await expect(reader.read()).rejects.toThrow();
    expect((await request()).status).toBe(401);
    expect(() => bridge.issue()).toThrow("unavailable");
    grant = { ...previous, identityRevision: "new-login" };
    const next = bridge.issue();
    expect(next.token).not.toBe(credential.token);
    next.revoke();
  });

  it.each([
    ["userId", "other-user"],
    ["tenantId", "other-tenant"],
  ] as const)(
    "rejects and revokes a credential after verified %s changes",
    async (field, value) => {
      let calls = 0;
      upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
        calls++;
        res.json({ choices: [] });
      });
      const previous = grant!;
      grant = { ...previous, [field]: value };

      const rejected = await request();
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toEqual({
        error: {
          message: "Assistant access is unavailable.",
          type: "permission_error",
          code: "assistant_access_unavailable",
        },
      });
      expect((await request()).status).toBe(401);

      grant = previous;
      credential = bridge.issue();
      grant = { ...previous, [field]: `notified-${field}` };
      changed();
      expect((await request()).status).toBe(401);
      expect(calls).toBe(0);
    },
  );

  it("requires explicit service configuration outside the production environment", () => {
    expect(() =>
      assistantUpstreams({
        ...grant!.environment,
        name: "staging",
        services: {},
      }),
    ).toThrow("not configured");
    expect(() =>
      assistantUpstreams({
        ...grant!.environment,
        services: { llm: "http://remote.example" },
      }),
    ).toThrow("Invalid");
    expect(
      assistantUpstreams({
        ...grant!.environment,
        name: "production",
        apiURL: "https://api.sapiom.ai",
        services: {},
      }).llm.href,
    ).toBe("https://llm.services.sapiom.ai/v2/openai/v1/chat/completions");
  });
});
