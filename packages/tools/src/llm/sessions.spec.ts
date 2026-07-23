/**
 * llm.createSession() / getSession() / callSession() / releaseSession() —
 * Surface B wire shape: the REST create body (snake_case, config in the BODY
 * not headers), the dispatch-handle shape, optional-webhook semantics (poll-only
 * is legitimate; the resume token rides webhook.token only when both a URL and
 * a token exist), wait() polling to a settled state, the repeatable call paths,
 * and the camelCase mapping of the session doc.
 *
 * Injects a fake fetch (no real network), mirroring submit.spec.ts.
 */
import { createClient } from "../index.js";
import { LLM_SESSION_READY_SIGNAL } from "./index.js";

interface Captured {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const READY_DOC = {
  session_id: "sess-1",
  state: "ready",
  model: "sonnet",
  base_urls: {
    anthropic: "https://llm.services.sapiom.ai/v2/sessions/sess-1/anthropic",
    openai: "https://llm.services.sapiom.ai/v2/sessions/sess-1/openai/v1",
  },
  expires_at_ms: 1_726_574_400_000,
  budget: { max_tokens: 2_000_000, used_tokens: 0, ttl_minutes: 120 },
};

/** 202 on POST /v2/sessions, then the given docs on successive GETs (poll). */
function fakeSessionFetch(
  capture: Captured,
  getDocs: Array<Record<string, unknown>> = [READY_DOC],
): typeof globalThis.fetch {
  const polls = [...getDocs];
  return (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method === "POST" && url.endsWith("/v2/sessions")) {
      capture.url = url;
      capture.method = method;
      capture.headers = init.headers as Record<string, string>;
      capture.body = init.body as string;
      return {
        ok: true,
        status: 202,
        json: async () => ({
          session_id: "sess-1",
          state: "pending",
          model: "sonnet",
          poll: "/v2/sessions/sess-1",
        }),
        text: async () => "",
      } as unknown as Response;
    }
    if (method === "DELETE") {
      capture.url = url;
      capture.method = method;
      return {
        ok: true,
        status: 200,
        json: async () => ({ session_id: "sess-1", state: "expired", released: true }),
        text: async () => "",
      } as unknown as Response;
    }
    if (method === "POST") {
      // session-scoped LLM call
      capture.url = url;
      capture.method = method;
      capture.headers = init.headers as Record<string, string>;
      capture.body = init.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({ type: "message", model: "sonnet", content: [] }),
        text: async () => "",
      } as unknown as Response;
    }
    const doc = polls.length > 1 ? polls.shift() : polls[0];
    return {
      ok: true,
      status: 200,
      json: async () => doc,
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("llm.createSession — REST create + dispatch handle", () => {
  it("POSTs a plain JSON body (config in the body, never headers) and returns a handle", async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeSessionFetch(cap) });
    const handle = await sapiom.llm.createSession({
      label: "sonnet",
      deadlineMinutes: 60,
      budget: { maxTokens: 2_000_000, ttlMinutes: 120 },
      neverFail: true,
    });
    expect(cap.url).toMatch(/\/v2\/sessions$/);
    expect(JSON.parse(cap.body!)).toEqual({
      label: "sonnet",
      deadline_minutes: 60,
      budget: { max_tokens: 2_000_000, ttl_minutes: 120 },
      never_fail: true,
    });
    // Routing config must NOT leak into headers on the sessions surface.
    const headerNames = Object.keys(cap.headers ?? {}).map((h) => h.toLowerCase());
    // Routing config must NOT leak into headers (sessions are body-driven); the
    // api-key + client marker are legitimate transport headers, not routing.
    expect(
      headerNames.filter(
        (h) => h.startsWith("x-sapiom-") && h !== "x-sapiom-api-key" && h !== "x-sapiom-client",
      ),
    ).toEqual([]);
    expect(handle.sessionId).toBe("sess-1");
    expect(handle.dispatch).toEqual({
      correlationId: "sess-1",
      resultSignal: LLM_SESSION_READY_SIGNAL,
    });
  });

  it("LLM_SESSION_READY_SIGNAL is the capability-stable settled signal", () => {
    expect(LLM_SESSION_READY_SIGNAL).toBe("llm.session.ready");
  });

  it("label and model are mutually exclusive", async () => {
    const sapiom = createClient({ apiKey: "k", fetch: fakeSessionFetch({}) });
    await expect(
      sapiom.llm.createSession({ label: "sonnet", model: "x" }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("webhook is OPTIONAL (poll-only mode sends none)", async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeSessionFetch(cap) });
    await sapiom.llm.createSession({ label: "sonnet" });
    expect(JSON.parse(cap.body!)).toEqual({ label: "sonnet" });
  });

  it("webhook carries url/secret and the ambient resume token as webhook.token", async () => {
    const cap: Captured = {};
    const sapiom = createClient({
      apiKey: "k",
      resumeToken: "resume-tok",
      fetch: fakeSessionFetch(cap),
    });
    await sapiom.llm.createSession({
      label: "sonnet",
      webhookUrl: "https://engine.example/llm-callback",
      webhookSecret: "s3cret",
    });
    expect(JSON.parse(cap.body!).webhook).toEqual({
      url: "https://engine.example/llm-callback",
      secret: "s3cret",
      token: "resume-tok",
    });
  });

  it("wait() polls past pending and resolves the mapped session", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeSessionFetch({}, [
        { session_id: "sess-1", state: "pending" },
        READY_DOC,
      ]),
    });
    const handle = await sapiom.llm.createSession({ label: "sonnet" });
    const session = await handle.wait({ pollMs: 1 });
    expect(session).toEqual({
      sessionId: "sess-1",
      state: "ready",
      model: "sonnet",
      baseUrls: READY_DOC.base_urls,
      expiresAtMs: READY_DOC.expires_at_ms,
      budget: { maxTokens: 2_000_000, usedTokens: 0, ttlMinutes: 120 },
    });
  });

  it("wait() resolves failed sessions too (caller branches on state)", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeSessionFetch({}, [
        { session_id: "sess-1", state: "failed", error: "deadline_exhausted" },
      ]),
    });
    const handle = await sapiom.llm.createSession({ label: "sonnet" });
    const session = await handle.wait({ pollMs: 1 });
    expect(session.state).toBe("failed");
    expect(session.error).toBe("deadline_exhausted");
  });
});

describe("llm.callSession / releaseSession — the repeatable surface", () => {
  it("POSTs the verbatim request to the session-scoped anthropic path by default", async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeSessionFetch(cap) });
    const req = { max_tokens: 64, messages: [{ role: "user", content: "hi" }] };
    await sapiom.llm.callSession("sess-1", req);
    expect(cap.url).toMatch(/\/v2\/sessions\/sess-1\/anthropic\/v1\/messages$/);
    expect(JSON.parse(cap.body!)).toEqual(req);
    // No grant token — the caller's normal identity is the only credential.
    const headerNames = Object.keys(cap.headers ?? {}).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("x-sapiom-grant-token");
  });

  it('shape: "openai" targets the chat-completions path', async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeSessionFetch(cap) });
    await sapiom.llm.callSession("sess-1", {}, { shape: "openai" });
    expect(cap.url).toMatch(/\/v2\/sessions\/sess-1\/openai\/v1\/chat\/completions$/);
  });

  it("accepts a handle or session object in place of the id", async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeSessionFetch(cap) });
    const handle = await sapiom.llm.createSession({ label: "sonnet" });
    await sapiom.llm.callSession(handle, {});
    expect(cap.url).toMatch(/\/v2\/sessions\/sess-1\/anthropic\/v1\/messages$/);
  });

  it("releaseSession DELETEs the resource and maps the terminal doc", async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeSessionFetch(cap) });
    const out = await sapiom.llm.releaseSession("sess-1");
    expect(cap.method).toBe("DELETE");
    expect(cap.url).toMatch(/\/v2\/sessions\/sess-1$/);
    expect(out.state).toBe("expired");
  });
});
