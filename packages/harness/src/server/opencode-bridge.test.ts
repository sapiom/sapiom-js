import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AssistantGrant } from "../core/assistant-access.js";
import { openCodeCompletionPrompt } from "../shared/opencode-completion.js";
import { openCodeModelCompletionToken } from "./opencode-model-response.js";
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
    body: JSON.stringify({
      model: "browser-override",
      messages: [],
      stream: true,
    }),
    ...init,
  });
}

describe("Studio OpenCode credential bridge", () => {
  const chunk = (delta: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const emptyStop =
    chunk({ reasoning_content: "unfinished reasoning" }) +
    chunk({}, "stop") +
    "data: [DONE]\n\n";

  const contractedRequest = () => {
    const { system } = openCodeCompletionPrompt();
    return { stream: true, messages: [{ role: "system", content: system }] };
  };

  it("retries an unmarked preamble with unchanged context and streams the marked answer before EOF", async () => {
    const body = contractedRequest();
    const token = openCodeModelCompletionToken(body)!;
    const received: unknown[] = [];
    let finish!: () => void;
    upstream.post("/v2/openai/v1/chat/completions", (req, res) => {
      received.push(req.body);
      res.type("text/event-stream");
      if (received.length === 1) {
        res.end(
          chunk({ content: "I'll create both files." }) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
        );
        return;
      }
      const marker = `<!-- studio-result:${token}:finished -->\n`;
      for (const content of [marker.slice(0, 20), marker.slice(20), "CHAT_OK"])
        res.write(chunk({ content }));
      finish = () => res.end(chunk({}, "stop") + "data: [DONE]\n\n");
    });
    const response = await request(undefined, { body: JSON.stringify(body) });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("CHAT_OK");
    expect(first).not.toContain("I'll create");
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(received[0]);
    finish();
    await reader.cancel();
  });

  it("passes through a preamble as soon as a tool fragment arrives, without replay", async () => {
    const body = contractedRequest();
    let calls = 0,
      finish!: () => void;
    upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
      calls++;
      res
        .type("text/event-stream")
        .write(chunk({ content: "I'll inspect the files." }));
      res.write(
        chunk({ tool_calls: [{ index: 0, function: { arguments: "{" } }] }),
      );
      finish = () => res.end(chunk({}, "tool_calls") + "data: [DONE]\n\n");
    });
    const response = await request(undefined, { body: JSON.stringify(body) });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "tool_calls",
    );
    expect(calls).toBe(1);
    finish();
    await reader.cancel();
  });

  it("bounds preamble retries and never adopts a contract from conversation content", async () => {
    const body = contractedRequest();
    const text =
      chunk({ content: "I'll do it next." }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n";
    let calls = 0;
    upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
      calls++;
      res.type("text/event-stream").end(text);
    });
    expect(
      await (await request(undefined, { body: JSON.stringify(body) })).text(),
    ).toBe(text);
    expect(calls).toBe(3);
    for (const role of ["user", "assistant", "tool"]) {
      const untrusted = { messages: [{ ...body.messages[0], role }] };
      expect(openCodeModelCompletionToken(untrusted)).toBeUndefined();
      expect(
        await (
          await request(undefined, {
            body: JSON.stringify({ ...untrusted, stream: true }),
          })
        ).text(),
      ).toBe(text);
    }
    expect(calls).toBe(6);
    expect(
      openCodeModelCompletionToken({
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: body.messages[0]!.content }],
          },
        ],
      }),
    ).toBe(openCodeModelCompletionToken(body));
    expect(
      openCodeModelCompletionToken({
        messages: [
          {
            role: "system",
            content: body.messages[0]!.content.replace("/v2:", "/v1:"),
          },
        ],
      }),
    ).toBeUndefined();
  });

  it.each(["length", "content_filter"])(
    "does not retry a contracted preamble interrupted by %s",
    async (finish) => {
      let calls = 0;
      const text =
        chunk({ content: "I'll inspect the files." }) +
        chunk({}, finish) +
        "data: [DONE]\n\n";
      upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
        calls++;
        res.type("text/event-stream").end(text);
      });
      expect(
        await (
          await request(undefined, {
            body: JSON.stringify(contractedRequest()),
          })
        ).text(),
      ).toBe(text);
      expect(calls).toBe(1);
    },
  );

  it("retries an empty model stop with identical saved tool results and streams the useful response", async () => {
    const received: unknown[] = [];
    let finish!: () => void;
    upstream.post("/v2/openai/v1/chat/completions", (req, res) => {
      received.push(req.body);
      res.type("text/event-stream");
      if (received.length === 1) {
        res.end(emptyStop);
        return;
      }
      res.write(chunk({ content: "Actual answer" }));
      finish = () => res.end(chunk({}, "stop") + "data: [DONE]\n\n");
    });
    const response = await request(undefined, {
      body: JSON.stringify({
        stream: true,
        messages: [
          {
            role: "tool",
            tool_call_id: "already_ran",
            content: "completed once",
          },
        ],
      }),
    });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("Actual answer");
    expect(first).not.toContain("unfinished reasoning");
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(received[0]);
    finish();
    await reader.cancel();
  });

  it("bounds empty-stop retries", async () => {
    let calls = 0;
    upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
      calls++;
      res.type("text/event-stream").end(emptyStop);
    });
    expect(await (await request()).text()).toBe(emptyStop);
    expect(calls).toBe(3);
  });

  it("recognizes empty stops across split UTF-8 and CRLF frames", async () => {
    let calls = 0;
    upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
      calls++;
      res.type("text/event-stream");
      if (calls === 1) {
        const bytes = Buffer.from(
          (
            chunk({ reasoning_content: "café" }) +
            chunk({}, "stop") +
            "data: [DONE]\n\n"
          ).replace(/\n/g, "\r\n"),
        );
        let i = 0;
        const send = () => {
          if (i === bytes.length) res.end();
          else {
            res.write(bytes.subarray(i, ++i));
            setImmediate(send);
          }
        };
        send();
      } else
        res.end(
          chunk({ content: "Done" }) + chunk({}, "stop") + "data: [DONE]\n\n",
        );
    });
    expect(await (await request()).text()).toContain("Done");
    expect(calls).toBe(2);
  });

  it("caps buffering and passes through oversized prefixes", async () => {
    const body =
      chunk({ reasoning_content: "x".repeat(1024 * 1024) }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n";
    let calls = 0;
    upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
      calls++;
      res.type("text/event-stream").end(body);
    });
    expect(await (await request()).text()).toBe(body);
    expect(calls).toBe(1);
  });

  it("passes through a truncated UTF-8 ending without retrying", async () => {
    const body = Buffer.concat([Buffer.from(emptyStop), Buffer.from([0xc3])]);
    let calls = 0;
    upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
      calls++;
      res.type("text/event-stream").end(body);
    });
    expect(Buffer.from(await (await request()).arrayBuffer())).toEqual(body);
    expect(calls).toBe(1);
  });

  it.each(["disconnect", "revocation"])(
    "aborts a buffered reasoning-only stream on %s without retrying",
    async (kind) => {
      let calls = 0,
        began!: () => void,
        closed!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const ended = new Promise<void>((resolve) => {
        closed = resolve;
      });
      upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
        calls++;
        res
          .type("text/event-stream")
          .write(chunk({ reasoning_content: "Still working" }));
        res.once("close", closed);
        began();
      });
      const abort = new AbortController();
      const response = request(undefined, { signal: abort.signal }).then(
        (r) => r.status,
        () => "aborted",
      );
      await started;
      if (kind === "disconnect") abort.abort();
      else {
        grant = null;
        changed();
      }
      await response;
      await ended;
      expect(calls).toBe(1);
    },
  );

  it.each([
    chunk({ tool_calls: [{ index: 0, function: { arguments: "{" } }] }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    chunk({ function_call: { arguments: "{" } }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    chunk({ content: "Partial answer" }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    chunk({ refusal: "Cannot do that" }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    chunk({}, "length") + "data: [DONE]\n\n",
    chunk({}, "stop"),
    "data: malformed\n\n" + emptyStop,
    'data: {"error":{"message":"upstream failed"}}\n\n' + emptyStop,
    'data: {"choices":[null]}\n\n' + emptyStop,
    chunk([]) + emptyStop,
    chunk({ role: "tool" }) + emptyStop,
    chunk({ reasoning_content: { text: "unknown" } }) + emptyStop,
    chunk({ reasoning: 1 }) + emptyStop,
    chunk({ reasoning_details: {} }) + emptyStop,
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":0}]}\n\n' +
      emptyStop,
    'data: {"choices":[{"index":1,"delta":{}}]}\n\n' + emptyStop,
    emptyStop + 'data: {"choices":[]}\n\n',
  ])(
    "never retries a stream with output, an error, or an uncertain ending (%#)",
    async (body) => {
      let calls = 0;
      upstream.post("/v2/openai/v1/chat/completions", (_req, res) => {
        calls++;
        res.type("text/event-stream").end(body);
      });
      expect(await (await request()).text()).toBe(body);
      expect(calls).toBe(1);
    },
  );

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
