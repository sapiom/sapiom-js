import {
  assistantContentHash,
  serializeAcceptedAssistantSystem,
  studioAssistantCompletionSystem,
} from "@sapiom/opencode";
import { describe, expect, it, vi } from "vitest";
import {
  AssistantContinuationNative,
  AssistantContinuationUnconfirmedError,
} from "./assistant-continuation-native.js";
import type { AssistantContinuationReceipt } from "./assistant-continuation-store.js";
import type { HostedOpenCode } from "./opencode-host.js";
import { sourceContext } from "./test-fixtures/assistant-context.js";
import {
  acceptedAssistantRecord,
  createAssistantContextCandidate,
} from "./assistant-sources.js";

const token = "11111111-1111-4111-8111-111111111111";
function seedSystem({
  id = "child-studio",
  cwd = "/work",
  scope = "c".repeat(64),
  conversationId = "ses_saved",
  attemptToken = token,
  brief = "Saved public context. Wait for the next message.",
} = {}) {
  const context = sourceContext();
  Object.assign(context.session, { id, cwd });
  context.guidance.push({
    id: "continuation",
    kind: "continuation",
    source: "studio:record",
    required: true,
    status: "available",
    revision: null,
    text: brief,
  });
  const candidate = createAssistantContextCandidate(context, scope);
  const {
    context: facts,
    instructionSet,
    ...ref
  } = acceptedAssistantRecord(candidate, scope, conversationId, token);
  const sources = instructionSet.sources.filter(
    (source) => source.status === "available",
  );
  const content = (source: (typeof sources)[number]) => ({
    sourceId: source.id,
    text: Buffer.from(
      candidate.materials.find((item) => item.sourceId === source.id)!.bytes,
    ).toString("utf8"),
  });
  return {
    ref,
    system: serializeAcceptedAssistantSystem(
      studioAssistantCompletionSystem(attemptToken),
      {
        schemaVersion: 2,
        accepted: ref,
        attemptToken,
        context: facts,
        stable: {
          policy: content(sources.find((source) => source.kind === "policy")!),
          guidance: sources
            .filter(
              (source) => source.kind !== "policy" && source.format === "utf8",
            )
            .map(content),
          manifests: sources
            .filter((source) => source.format === "json")
            .map(content),
          sourceManifest: instructionSet,
        },
      },
    ),
  };
}

function fixture() {
  const controller = new AbortController(),
    hostController = new AbortController();
  let receipt = {
    childStudioId: "child-studio",
    operationId: "operation",
    nativeCreationMarker: "continuation-operation-child",
    phase: "allocated",
    brief: {
      text: "Saved public context. Wait for the next message.",
      sha256: "",
    },
    seedMessageId: "msg_seed",
    seedPartId: "prt_seed",
    childBinding: null,
    acceptedRef: null,
    acceptanceId: token,
    attemptToken: token,
  } as unknown as AssistantContinuationReceipt;
  receipt.brief.sha256 = assistantContentHash(receipt.brief.text);
  const acceptedSeed = seedSystem();
  const sessions: Record<string, unknown>[] = [],
    messages: Record<string, unknown>[] = [];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let loseCreate = false,
    loseSeed = false;
  const fetch = vi.fn(
    async (path: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        posts.push({ path, body });
        if (path === "/session") {
          sessions.push({ ...body, id: "ses_saved", directory: "/work" });
          if (loseCreate) throw new Error("lost create response");
          return Response.json(sessions[0]);
        }
        const row = {
          info: {
            id: body.messageID,
            sessionID: "ses_saved",
            role: "user",
            system: body.system,
          },
          parts: (body.parts as Record<string, unknown>[]).map((part) => ({
            ...part,
            messageID: body.messageID,
            sessionID: "ses_saved",
          })),
        };
        messages.push(row);
        if (loseSeed) throw new Error("lost seed response");
        return Response.json(row); // Native synchronous noReply returns a USER, not SDK's assistant type.
      }
      if (path.startsWith("/session?")) return Response.json(sessions);
      if (path === "/session/ses_saved")
        return Response.json(sessions[0] ?? {}, {
          status: sessions.length ? 200 : 404,
        });
      if (path.endsWith("/message/msg_seed"))
        return Response.json(messages[0] ?? {}, {
          status: messages.length ? 200 : 404,
        });
      if (path.endsWith("/message")) return Response.json(messages);
      throw new Error(`unexpected native path ${path}`);
    },
  );
  const hosted = {
    harnessSessionId: "child-studio",
    cwd: "/work",
    contextAuthorityScope: "c".repeat(64),
    signal: hostController.signal,
    model: { providerID: "sapiom", modelID: "test" },
    server: { fetch },
  } as unknown as HostedOpenCode;
  const current = vi.fn(async () => {});
  const native = new AssistantContinuationNative(current);
  const advance = vi.fn(async (patch) => (receipt = { ...receipt, ...patch }));
  const conversation = () =>
    native.conversation(hosted, receipt, advance, controller.signal);
  const seed = () =>
    native.seed(
      hosted,
      receipt,
      acceptedSeed.system,
      advance,
      controller.signal,
    );
  const associate = () => {
    receipt = {
      ...receipt,
      phase: "accepting",
      childBinding: {
        harnessSessionId: hosted.harnessSessionId,
        cwd: hosted.cwd,
        contextAuthorityScope: hosted.contextAuthorityScope,
        conversationId: "ses_saved",
      },
      acceptedRef: acceptedSeed.ref,
    };
  };
  return {
    native,
    hosted,
    current,
    controller,
    hostController,
    sessions,
    messages,
    posts,
    fetch,
    advance,
    conversation,
    seed,
    system: acceptedSeed.system,
    associate,
    get receipt() {
      return receipt;
    },
    setReceipt(value: Partial<AssistantContinuationReceipt>) {
      receipt = { ...receipt, ...value };
    },
    loseCreate() {
      loseCreate = true;
    },
    loseSeed() {
      loseSeed = true;
    },
  };
}

describe("trusted Assistant continuation native protocol", () => {
  it("persists intent before one create and reconciles the same marked conversation after lost response/restart", async () => {
    const f = fixture();
    f.loseCreate();
    expect(await f.conversation()).toBe("ses_saved");
    expect(f.advance).toHaveBeenCalledWith({ phase: "creating" });
    expect(f.advance.mock.invocationCallOrder[0]).toBeLessThan(
      f.fetch.mock.invocationCallOrder[0]!,
    );
    expect(
      await new AssistantContinuationNative(f.current).conversation(
        f.hosted,
        f.receipt,
        f.advance,
        f.controller.signal,
      ),
    ).toBe("ses_saved");
    expect(f.posts).toHaveLength(1);
  });
  it("does not create after a crash between durable intent and the original request", async () => {
    const f = fixture();
    f.setReceipt({ phase: "creating" });
    await expect(f.conversation()).rejects.toBeInstanceOf(
      AssistantContinuationUnconfirmedError,
    );
    expect(f.posts).toHaveLength(0);
  });
  it("rejects absent or ambiguous markers and truncated discovery", async () => {
    for (const count of [0, 2, 100]) {
      const f = fixture();
      await f.conversation();
      const original = f.sessions[0]!;
      f.sessions.splice(
        0,
        f.sessions.length,
        ...Array.from({ length: count }, () => ({ ...original })),
      );
      await expect(f.conversation()).rejects.toBeInstanceOf(
        AssistantContinuationUnconfirmedError,
      );
      expect(f.posts).toHaveLength(1);
    }
  });
  it("requires both operation metadata and title, then exact native workspace", async () => {
    for (const patch of [
      { title: "different" },
      { metadata: {} },
      { directory: "/foreign" },
      { id: "child-studio" },
    ]) {
      const f = fixture();
      await f.conversation();
      Object.assign(f.sessions[0]!, patch);
      await expect(f.conversation()).rejects.toBeInstanceOf(
        AssistantContinuationUnconfirmedError,
      );
      expect(f.posts).toHaveLength(1);
    }
  });
  it("prepares exactly one synthetic no-reply message, verifies USER readback, and never dispatches work", async () => {
    const f = fixture();
    await f.conversation();
    f.associate();
    f.loseSeed();
    await f.seed();
    const post = f.posts[1]!;
    expect(post.path).toBe("/session/ses_saved/message");
    expect(post.body).toMatchObject({
      noReply: true,
      system: f.system,
      messageID: "msg_seed",
      agent: "build",
      model: { providerID: "sapiom", modelID: "test" },
      parts: [
        {
          id: "prt_seed",
          synthetic: true,
          ignored: false,
          text: f.receipt.brief.text,
        },
      ],
    });
    expect(post.body).not.toHaveProperty("tools");
    await new AssistantContinuationNative(f.current).seed(
      f.hosted,
      f.receipt,
      f.system,
      f.advance,
      f.controller.signal,
    );
    expect(f.posts).toHaveLength(2); // one conversation + one seed, including lost-response retry
    expect(
      f.fetch.mock.calls.some(([path]) =>
        /prompt_async|\/recover|\/tool/.test(path),
      ),
    ).toBe(false);
  });
  it("never resends when persisted seed intent has no verified native message", async () => {
    const f = fixture();
    await f.conversation();
    f.associate();
    f.setReceipt({ phase: "seeding" });
    await expect(f.seed()).rejects.toBeInstanceOf(
      AssistantContinuationUnconfirmedError,
    );
    expect(f.posts).toHaveLength(1);
  });
  it("does not overwrite changed seed bytes, flags, identities, or system", async () => {
    const changes = [
      (row: any) => {
        row.parts[0].text = "changed";
      },
      (row: any) => {
        row.parts[0].synthetic = false;
      },
      (row: any) => {
        row.parts[0].ignored = true;
      },
      (row: any) => {
        row.parts[0].metadata.sapiomContinuation.briefHash = "other";
      },
      (row: any) => {
        row.parts[0].messageID = "msg_other";
      },
      (row: any) => {
        row.info.system = "other accepted context";
      },
      (row: any) => {
        row.info.role = "assistant";
      },
    ];
    for (const change of changes) {
      const f = fixture();
      await f.conversation();
      f.associate();
      await f.seed();
      change(f.messages[0]);
      await expect(f.seed()).rejects.toBeInstanceOf(
        AssistantContinuationUnconfirmedError,
      );
      expect(f.posts).toHaveLength(2);
    }
  });
  it("rejects duplicate operation seeds, including a different native message ID", async () => {
    const f = fixture();
    await f.conversation();
    f.associate();
    await f.seed();
    f.messages.push(JSON.parse(JSON.stringify(f.messages[0])));
    await expect(f.seed()).rejects.toBeInstanceOf(
      AssistantContinuationUnconfirmedError,
    );
    expect(f.posts).toHaveLength(2);
  });
  it("rejects foreign child identity before native IO", async () => {
    const f = fixture();
    f.associate();
    Object.assign(f.hosted, { contextAuthorityScope: "d".repeat(64) });
    await expect(f.seed()).rejects.toBeInstanceOf(
      AssistantContinuationUnconfirmedError,
    );
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("End after durable creation intent prevents the native POST", async () => {
    const f = fixture();
    f.advance.mockImplementationOnce(async (patch) => {
      f.setReceipt(patch);
      f.hostController.abort(new Error("ended"));
      return f.receipt;
    });
    await expect(f.conversation()).rejects.toThrow("ended");
    expect(f.receipt.phase).toBe("creating");
    expect(f.posts).toHaveLength(0);
  });
  it("cancels a hung native request when the exact host ends", async () => {
    const f = fixture();
    f.setReceipt({ phase: "creating" });
    f.fetch.mockImplementationOnce(async () => new Promise<Response>(() => {}));
    const request = f.conversation();
    const rejected = expect(request).rejects.toThrow("ended");
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalled());
    f.hostController.abort(new Error("ended"));
    await rejected;
    expect(f.posts).toHaveLength(0);
  });
  it("rejects non-receipt context, parent facts, changed brief and attempt before native IO", async () => {
    for (const change of [
      { id: "parent-studio" },
      { cwd: "/foreign" },
      { scope: "d".repeat(64) },
      { conversationId: "ses_parent" },
      { attemptToken: "22222222-2222-4222-8222-222222222222" },
      { brief: "Changed continuation" },
    ]) {
      const f = fixture();
      f.associate();
      const wrong = seedSystem(change);
      f.setReceipt({ acceptedRef: wrong.ref });
      await expect(
        f.native.seed(
          f.hosted,
          f.receipt,
          wrong.system,
          f.advance,
          f.controller.signal,
        ),
      ).rejects.toBeInstanceOf(AssistantContinuationUnconfirmedError);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.advance).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.associate();
    for (const system of [
      "",
      "generic system",
      f.system.replace(
        "StudioAssistantContext/v2",
        "StudioAssistantContext/v3",
      ),
    ]) {
      await expect(
        f.native.verifySeed(f.hosted, f.receipt, system, f.controller.signal),
      ).rejects.toBeInstanceOf(AssistantContinuationUnconfirmedError);
    }
    f.setReceipt({
      acceptedRef: { ...f.receipt.acceptedRef!, revision: "f".repeat(64) },
    });
    await expect(f.seed()).rejects.toBeInstanceOf(
      AssistantContinuationUnconfirmedError,
    );
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("End settles a held authority check before either native mutation", async () => {
    for (const kind of ["create", "seed"] as const) {
      const f = fixture();
      if (kind === "seed") f.associate();
      f.current.mockImplementationOnce(async () => new Promise<void>(() => {}));
      let result: unknown;
      const request = (kind === "create" ? f.conversation() : f.seed()).catch(
        (error) => {
          result = error;
        },
      );
      await vi.waitFor(() => expect(f.current).toHaveBeenCalled());
      f.hostController.abort(new Error("ended during authority"));
      await vi.waitFor(() =>
        expect(result).toMatchObject({ message: "ended during authority" }),
      );
      await request;
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.advance).not.toHaveBeenCalled();
    }
  });
  it("cancels a stalled response body on either caller or runtime End", async () => {
    for (const owner of ["controller", "hostController"] as const) {
      const f = fixture(),
        cancel = vi.fn(),
        pull = vi.fn();
      f.setReceipt({ phase: "creating" });
      f.fetch.mockResolvedValueOnce(
        new Response(new ReadableStream({ pull, cancel })),
      );
      const request = f.conversation();
      const rejected = expect(request).rejects.toThrow("ended stream");
      await vi.waitFor(() => expect(pull).toHaveBeenCalled());
      f[owner].abort(new Error("ended stream"));
      await rejected;
      expect(cancel).toHaveBeenCalled();
      expect(f.posts).toHaveLength(0);
    }
  });
  it("discards a late HTTP response after cancellation even if fetch ignored the signal", async () => {
    const f = fixture(),
      cancel = vi.fn();
    let resolve!: (response: Response) => void;
    f.setReceipt({ phase: "creating" });
    f.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const request = f.conversation();
    const rejected = expect(request).rejects.toThrow("ended late");
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalled());
    f.hostController.abort(new Error("ended late"));
    await rejected;
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });
  it("rejects malformed and oversized discovery bodies without creating again", async () => {
    for (const body of ["{broken", new Uint8Array(16 * 1024 * 1024 + 1)]) {
      const f = fixture();
      f.setReceipt({ phase: "creating" });
      f.fetch.mockResolvedValueOnce(new Response(body));
      await expect(f.conversation()).rejects.toBeInstanceOf(
        AssistantContinuationUnconfirmedError,
      );
      expect(f.posts).toHaveLength(0);
    }
  });
  it("requires exact seed identity and content in history as well as direct readback", async () => {
    for (const change of [
      (row: any) => {
        row.info.id = "msg_other";
      },
      (row: any) => {
        row.info.role = "assistant";
      },
      (row: any) => {
        row.parts[0].text = "Changed in later history read";
      },
    ]) {
      const f = fixture();
      await f.conversation();
      f.associate();
      await f.seed();
      const history = JSON.parse(JSON.stringify(f.messages));
      change(history[0]);
      f.fetch.mockResolvedValueOnce(Response.json(f.messages[0]));
      f.fetch.mockResolvedValueOnce(Response.json(history));
      await expect(f.seed()).rejects.toBeInstanceOf(
        AssistantContinuationUnconfirmedError,
      );
      expect(f.posts).toHaveLength(2);
    }
  });
});
