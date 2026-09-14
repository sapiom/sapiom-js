import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantContinuation } from "./assistant-continuation.js";
import { AssistantContinuationStore } from "./assistant-continuation-store.js";
import { AssistantSessionStore } from "./assistant-session-store.js";
import { AssistantLifecycleCoordinator } from "./assistant-lifecycle.js";
import { projectAssistantRecord } from "./assistant-record.js";
import { FileAssistantSourceStore } from "./assistant-source-store.js";
import { createAssistantContextDelivery } from "./studio-assistant-delivery.js";
import { createAssistantContextCandidate } from "./assistant-sources.js";
import { assertAssistantRuntimeReady } from "./assistant-runtime-readiness.js";
import { sourceContext } from "./test-fixtures/assistant-context.js";
import type { HostedOpenCode } from "./opencode-host.js";
import type { HarnessSession } from "../shared/types.js";
import type { AssistantContinuationNative } from "./assistant-continuation-native.js";

const op = "11111111-1111-4111-8111-111111111111";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const request = {
  expectedRevision: 1,
  expectedRecordRevision: 7,
  operationId: op,
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
let root: string;
let cleanup: () => void;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-continue-integration-"));
  cleanup = () => {};
});
afterEach(async () => {
  cleanup();
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const store = new AssistantContinuationStore(root),
    associations = new AssistantSessionStore(root);
  const binding = {
    harnessSessionId: "parent",
    contextAuthorityScope: digest("context/parent"),
    cwd: root,
    conversationId: "ses_parent",
  };
  await associations.associate(
    binding,
    digest("native/parent"),
    async () => binding.conversationId,
  );
  await associations.transition("parent", 0, {
    lifecycle: "ended",
    execution: "paused",
  });
  const source = {
    id: "parent",
    cwd: root,
    harness: "claude-code",
    status: "exited",
    title: "Source",
    agentMapIdentity: {
      sessionId: "parent",
      projectId: "project",
      userId: "user",
    },
    boundWorkflowPath: null,
    agentSessionId: "terminal-original",
  } as unknown as HarnessSession;
  const rows = new Map<string, HarnessSession>([[source.id, source]]);
  let authorized = true,
    loseSeed = false;
  const authorize = vi.fn(async (id: string) =>
    authorized
      ? associations.association({
          harnessSessionId: id,
          cwd: root,
          contextAuthorityScope: digest(`context/${id}`),
        })
      : null,
  );
  const records = {
    read: vi.fn(async () =>
      projectAssistantRecord(
        [
          {
            info: {
              id: "msg_user",
              sessionID: "ses_parent",
              role: "user",
              time: { created: 1 },
            },
            parts: [
              {
                id: "prt_text",
                sessionID: "ses_parent",
                messageID: "msg_user",
                type: "text",
                text: "Preserve the completed draft.",
              },
            ],
          },
        ],
        binding,
        7,
      ),
    ),
  };
  const allocationInputs = new Map<string, string>();
  const sessions = {
    get: (id: string) => rows.get(id),
    allocateDormant: vi.fn(async (_sourceId, input) => {
      const encoded = JSON.stringify(input),
        saved = allocationInputs.get(input.childSessionId);
      if (saved && saved !== encoded)
        throw new Error("allocation identity changed");
      allocationInputs.set(input.childSessionId, encoded);
      const existing = rows.get(input.childSessionId);
      if (existing) return existing;
      const child = {
        ...source,
        id: input.childSessionId,
        title: "Child",
        agentSessionId: null,
        terminalState: "not-started",
        agentMapIdentity: {
          ...source.agentMapIdentity!,
          sessionId: input.childSessionId,
        },
      } as HarnessSession;
      rows.set(child.id, child);
      return child;
    }),
  };
  const hosts = new Map<string, HostedOpenCode>(),
    controllers = new Map<HostedOpenCode, AbortController>();
  const host = {
    current: (id: string) => hosts.get(id) ?? null,
    ensure: vi.fn(async (id: string): Promise<HostedOpenCode> => {
      const previous = hosts.get(id);
      if (previous) return previous;
      const controller = new AbortController(),
        stateRoot = join(root, "opencode", digest(`native/${id}`));
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });
      const hosted: HostedOpenCode = {
        harnessSessionId: id,
        cwd: root,
        stateRoot,
        contextAuthorityScope: digest(`context/${id}`),
        model: { providerID: "sapiom", modelID: "fixture" },
        signal: controller.signal,
        isCurrent: () =>
          authorized && !controller.signal.aborted && hosts.get(id) === hosted,
        server: {
          pid: 123,
          exited: new Promise(() => {}),
          close: async () => {},
          fetch: vi.fn(),
          fetchJson: vi.fn(),
        },
      };
      hosts.set(id, hosted);
      controllers.set(hosted, controller);
      return hosted;
    }),
    assertCurrent: vi.fn(async (hosted: HostedOpenCode) => {
      if (!hosted.isCurrent()) throw new Error("authority changed");
    }),
    retireExact: async (hosted: HostedOpenCode) => {
      controllers.get(hosted)?.abort();
      if (hosts.get(hosted.harnessSessionId) === hosted)
        hosts.delete(hosted.harnessSessionId);
    },
    retireWithResult: async (id: string) => {
      const hosted = hosts.get(id);
      if (hosted) await host.retireExact(hosted);
      return { state: hosted ? ("confirmed" as const) : ("absent" as const) };
    },
    observe: vi.fn(),
    beginShutdown: () => {
      for (const controller of controllers.values()) controller.abort();
      hosts.clear();
    },
  };
  cleanup = host.beginShutdown;
  const lifecycle = new AssistantLifecycleCoordinator({
    store: associations,
    host,
    canAttach: (id) => store.canAttach(id),
    associations: {
      ensure: async (hosted) => {
        const saved = await authorize(hosted.harnessSessionId);
        if (!saved) throw new Error("no saved association");
        return saved.conversationId;
      },
    },
  });
  const creations = new Set<string>(),
    seeds = new Set<string>();
  const native: Pick<AssistantContinuationNative, "conversation" | "seed"> = {
    conversation: vi.fn(async (_hosted, receipt, advance) => {
      if (receipt.phase === "allocated") {
        await advance({ phase: "creating" });
        creations.add(receipt.childStudioId);
      }
      if (!creations.has(receipt.childStudioId))
        throw new Error("native creation uncertain");
      return `ses_${receipt.childStudioId.replaceAll("-", "")}`;
    }),
    seed: vi.fn(async (_hosted, receipt, _system, advance) => {
      if (receipt.phase === "accepting") {
        await advance({ phase: "seeding" });
        seeds.add(receipt.seedMessageId);
        if (loseSeed) {
          loseSeed = false;
          throw new Error("lost seed acknowledgement");
        }
      }
      if (!seeds.has(receipt.seedMessageId))
        throw new Error("seed unavailable");
    }),
  };
  const resolveCandidate = vi.fn(async (hosted, receipt) => {
    const context = sourceContext();
    context.session = {
      ...context.session,
      id: hosted.harnessSessionId,
      cwd: hosted.cwd,
    };
    context.guidance.push({
      id: "recorded-continuation",
      kind: "continuation",
      required: true,
      source: `studio:${receipt.sourceBinding.harnessSessionId}`,
      revision: receipt.brief.sha256,
      status: "available",
      text: receipt.brief.text,
    });
    return createAssistantContextCandidate(
      context,
      hosted.contextAuthorityScope,
    );
  });
  const delivery = createAssistantContextDelivery({
    resolveContext: vi.fn(async () => {
      throw new Error("ordinary context resolver must not run");
    }),
    storeFor: (hosted) =>
      new FileAssistantSourceStore(
        hosted.stateRoot,
        hosted.contextAuthorityScope,
      ),
    assertCurrent: host.assertCurrent,
    prepareRuntime: async (_hosted, retained) =>
      assertAssistantRuntimeReady(retained),
  });
  const originalAccept = delivery.acceptFrozen;
  const accept = vi.spyOn(delivery, "acceptFrozen"),
    compose = vi.spyOn(delivery, "compose");
  const assertAvailable = vi.fn(async () => {});
  const options = {
    store,
    associations,
    lifecycle,
    records,
    sessions,
    authorize,
    native,
    delivery,
    resolveCandidate,
    assertAvailable,
  };
  const service = () => new AssistantContinuation(options);
  const instance = service();
  return {
    store,
    associations,
    binding,
    source,
    rows,
    hosts,
    host,
    lifecycle,
    records,
    sessions,
    native,
    creations,
    seeds,
    resolveCandidate,
    delivery,
    originalAccept,
    accept,
    compose,
    assertAvailable,
    service,
    run: () => instance.continue("parent", request),
    receipt: () => store.read(binding, op),
    revoke: () => {
      authorized = false;
    },
    loseSeed: () => {
      loseSeed = true;
    },
  };
}

it("creates one child with dormant Terminal and new accepted scope, retains the source, and returns paused", async () => {
  const f = await fixture();
  const original = JSON.stringify(f.source);
  const first = f.run();
  expect(f.run()).toBe(first);
  const result = await first;
  expect(result.session.id).not.toBe("parent");
  expect(result.session).toMatchObject({
    terminalState: "not-started",
    agentSessionId: null,
  });
  expect(result.attachment.lifecycle).toMatchObject({
    lifecycle: "open",
    execution: "paused",
  });
  expect(result.receipt).toMatchObject({
    phase: "prepared",
    sourceRecordRevision: 7,
    sourceLifecycleRevision: 1,
  });
  expect(result.receipt.acceptedRef?.authorityScope).not.toBe(
    f.binding.contextAuthorityScope,
  );
  expect(result.receipt.childBinding?.conversationId).not.toBe("ses_parent");
  expect(JSON.stringify(f.source)).toBe(original);
  expect(f.creations.size).toBe(1);
  expect(f.seeds.size).toBe(1);
  expect(f.accept).toHaveBeenCalledOnce();
  expect(f.host.observe).toHaveBeenCalledOnce();
});

it("reconciles a prepared operation after service restart without new context, allocation or native mutations", async () => {
  const f = await fixture();
  const first = await f.run();
  const running = f.hosts.get(first.session.id)!;
  await f.lifecycle.enable(running);
  const revision = (await f.lifecycle.describe(first.session.id)).revision;
  f.records.read.mockRejectedValue(new Error("latest record unavailable"));
  f.resolveCandidate.mockRejectedValue(new Error("current guidance changed"));
  const repeated = await f.service().continue("parent", request);
  expect(repeated.session.id).toBe(first.session.id);
  expect(repeated.attachment.lease).toBe(first.attachment.lease);
  expect(repeated.attachment.lifecycle).toMatchObject({
    revision,
    execution: "enabled",
  });
  expect(f.hosts.get(first.session.id)).toBe(running);
  expect(f.sessions.allocateDormant).toHaveBeenCalledTimes(2);
  expect(f.accept).toHaveBeenCalledOnce();
  expect(f.resolveCandidate).toHaveBeenCalledOnce();
  expect(f.creations.size).toBe(1);
  expect(f.seeds.size).toBe(1);
});

it("rejects a result when End wins after the child attachment was granted", async () => {
  const f = await fixture(),
    attach = f.lifecycle.attach.bind(f.lifecycle);
  vi.spyOn(f.lifecycle, "attach").mockImplementationOnce(async (...args) => {
    const attached = await attach(...args);
    const ending = f.lifecycle.beginEnd(args[0]);
    await ending.persistence;
    await f.lifecycle.finishEnd(ending.fence);
    return attached;
  });
  await expect(f.run()).rejects.toThrow();
  expect((await f.receipt())?.phase).toBe("prepared");
});

it("reconciles lost acceptance acknowledgement with the exact frozen candidate and acceptance ID", async () => {
  const f = await fixture();
  const original = f.originalAccept;
  f.accept.mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new Error("lost acceptance ack");
  });
  await expect(f.run()).rejects.toThrow("lost acceptance ack");
  const pending = (await f.receipt())!;
  expect(pending).toMatchObject({ phase: "accepting", acceptedRef: null });
  f.resolveCandidate.mockRejectedValue(new Error("new guidance unavailable"));
  const result = await f.service().continue("parent", request);
  expect(result.receipt.acceptedRef?.acceptanceId).toBe(pending.acceptanceId);
  expect(f.accept.mock.calls.map((args) => args[3])).toEqual([
    pending.acceptanceId,
    pending.acceptanceId,
  ]);
  expect(f.resolveCandidate).toHaveBeenCalledOnce();
  expect(f.creations.size).toBe(1);
});

it("reconciles a lost seed result using the existing accepted reference and child", async () => {
  const f = await fixture();
  f.loseSeed();
  await expect(f.run()).rejects.toThrow("lost seed acknowledgement");
  const pending = (await f.receipt())!;
  expect(pending.phase).toBe("seeding");
  f.records.read.mockRejectedValue(new Error("record changed"));
  const result = await f.service().continue("parent", request);
  expect(result.session.id).toBe(pending.childStudioId);
  expect(result.receipt.acceptedRef).toEqual(pending.acceptedRef);
  expect(f.accept).toHaveBeenCalledOnce();
  expect(f.seeds.size).toBe(1);
});

it("cannot repair lost committed material from a prepared receipt", async () => {
  const f = await fixture();
  const result = await f.run();
  const hosted = f.hosts.get(result.session.id)!;
  const objectPath = join(
    hosted.stateRoot,
    "assistant-context",
    "v1",
    hosted.contextAuthorityScope,
    "objects",
    result.receipt.brief.sha256,
  );
  await rm(objectPath);
  await expect(f.service().continue("parent", request)).rejects.toMatchObject({
    failure: { code: "context_unavailable" },
  });
  expect(f.accept).toHaveBeenCalledOnce();
  expect(f.seeds.size).toBe(1);
});

it("fails before allocating for inactive context delivery or missing required record", async () => {
  const f = await fixture();
  f.assertAvailable.mockRejectedValueOnce(new Error("context inactive"));
  await expect(f.run()).rejects.toThrow("context inactive");
  expect(f.records.read).not.toHaveBeenCalled();
  f.records.read.mockResolvedValueOnce(null as never);
  await expect(f.run()).rejects.toThrow();
  expect(f.sessions.allocateDormant).not.toHaveBeenCalled();
  expect(f.host.ensure).not.toHaveBeenCalled();
});

it("End during held child context preparation fences late acceptance and seeding", async () => {
  const f = await fixture();
  const held = gate(),
    original = f.resolveCandidate.getMockImplementation()!;
  f.resolveCandidate.mockImplementationOnce(async (...args) => {
    await held.promise;
    return original(...args);
  });
  const running = f.run();
  const failed = expect(running).rejects.toThrow();
  await vi.waitFor(() => expect(f.resolveCandidate).toHaveBeenCalled());
  const pending = (await f.receipt())!;
  const end = f.lifecycle.beginEnd(pending.childStudioId);
  await Promise.all([end.native, end.persistence]);
  await f.lifecycle.finishEnd(end.fence);
  await failed;
  held.release();
  await Promise.resolve();
  expect(f.accept).not.toHaveBeenCalled();
  expect(f.seeds.size).toBe(0);
  expect(await f.associations.lifecycle(pending.childStudioId)).toMatchObject({
    lifecycle: "ended",
  });
  await expect(f.service().continue("parent", request)).rejects.toThrow();
});

it("source End cancels pending preparation without changing the frozen source", async () => {
  const f = await fixture();
  const held = gate(),
    original = f.resolveCandidate.getMockImplementation()!;
  f.resolveCandidate.mockImplementationOnce(async (...args) => {
    await held.promise;
    return original(...args);
  });
  const running = f.run();
  const failed = expect(running).rejects.toThrow();
  await vi.waitFor(() => expect(f.resolveCandidate).toHaveBeenCalled());
  const pending = (await f.receipt())!,
    end = f.lifecycle.beginEnd("parent");
  await Promise.all([end.native, end.persistence]);
  await f.lifecycle.finishEnd(end.fence);
  await failed;
  held.release();
  expect(f.accept).not.toHaveBeenCalled();
  expect((await f.receipt())!.brief).toEqual(pending.brief);
});

it("a different source revision cannot adopt an existing operation", async () => {
  const f = await fixture();
  await f.run();
  await expect(
    f.service().continue("parent", { ...request, expectedRecordRevision: 8 }),
  ).rejects.toThrow("continuation changed");
  expect(f.creations.size).toBe(1);
});

it("revalidates the allocator digest after source and child move to another project at the same cwd", async () => {
  const f = await fixture();
  const first = await f.run();
  Object.assign(f.source.agentMapIdentity!, { projectId: "changed-project" });
  Object.assign(first.session.agentMapIdentity!, {
    projectId: "changed-project",
  });
  f.host.ensure.mockClear();
  vi.mocked(f.native.seed).mockClear();
  await expect(f.service().continue("parent", request)).rejects.toThrow(
    "allocation identity changed",
  );
  expect(f.host.ensure).not.toHaveBeenCalled();
  expect(f.native.seed).not.toHaveBeenCalled();
  expect(f.creations.size).toBe(1);
});
