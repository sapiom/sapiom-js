import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResolvedEnvironment } from "@sapiom/mcp/auth";
import {
  parseStudioAssistantSystem,
  type AcceptedAssistantContext,
} from "@sapiom/opencode";
import {
  createAssistantContextRuntime,
  type ActivatedAssistantContextRuntime,
} from "./assistant-context-runtime.js";
import { composeAssistantPrompt } from "../core/studio-assistant-context.js";
import {
  AssistantContinuationStore,
  freezeContinuationCandidate,
} from "../core/assistant-continuation-store.js";
import { projectAssistantRecord } from "../core/assistant-record.js";
import {
  retainAssistantGuidance,
  createAssistantSource,
  encodeAssistantSkillPackage,
} from "../core/assistant-sources.js";
import type { HostedOpenCode } from "../core/opencode-host.js";
import type { HarnessSession } from "../shared/types.js";
import type { StudioProjectIdentity } from "../core/studio-project-catalog.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "context-runtime-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const cwd = join(root, "project"),
    stateRoot = join(root, "opencode", "c".repeat(64));
  await mkdir(cwd);
  await mkdir(join(stateRoot, "engine"), { recursive: true });
  const binding = {
    harnessSessionId: "parent",
    contextAuthorityScope: "a".repeat(64),
    conversationId: "ses_parent",
    cwd,
  };
  const record = projectAssistantRecord(
    [
      {
        info: {
          id: "msg_parent",
          sessionID: "ses_parent",
          role: "user",
          time: { created: 1 },
        },
        parts: [
          {
            id: "prt_parent",
            messageID: "msg_parent",
            sessionID: "ses_parent",
            type: "text",
            text: "The prior result is complete. Wait for a new task.",
          },
        ],
      },
    ],
    binding,
    1,
  );
  const store = new AssistantContinuationStore(root);
  let receipt = await store.reserve(
    binding,
    1,
    0,
    randomUUID(),
    async () => record,
  );
  for (const phase of ["allocated", "creating"] as const)
    receipt = await store.update(receipt, { phase });
  receipt = await store.update(receipt, {
    phase: "associated",
    childBinding: {
      ...binding,
      harnessSessionId: receipt.childStudioId,
      conversationId: "ses_child",
      contextAuthorityScope: "b".repeat(64),
    },
  });
  const abort = new AbortController();
  const session: HarnessSession = {
    id: receipt.childStudioId,
    harness: "claude-code",
    cwd,
    title: "Child",
    agentSessionId: null,
    status: "exited",
    terminalState: "not-started",
    ready: false,
    createdAt: "2026-09-14T00:00:00.000Z",
    lastActiveAt: "2026-09-14T00:00:00.000Z",
    exitCode: null,
    boundWorkflowPath: null,
    rehydratedFrom: null,
    agentMapIdentity: {
      sessionId: receipt.childStudioId,
      projectId: "project",
      userId: "user",
    },
  };
  const project: StudioProjectIdentity = {
    projectId: "project",
    identityVersion: 1,
    displayName: "Project",
    rootBindings: [
      { id: "root", repositoryId: null, localRootRef: cwd, status: "active" },
    ],
    legacyWorkspaceKeys: [],
    createdAt: "2026-09-14",
    updatedAt: "2026-09-14",
  };
  const hosted: HostedOpenCode = {
    harnessSessionId: session.id,
    cwd,
    stateRoot,
    contextAuthorityScope: "b".repeat(64),
    model: { providerID: "sapiom", modelID: "test" },
    signal: abort.signal,
    isCurrent: () => !abort.signal.aborted,
    server: {
      pid: 1,
      exited: new Promise(() => {}),
      close: vi.fn(),
      fetch: vi.fn(),
      fetchJson: vi.fn().mockResolvedValue({ sapiom: { status: "connected" } }),
    },
  };
  const loadSystemPrompt = vi.fn(async () => "ORIGINAL_PROFILE_BYTES");
  const contextOptions = {
    getSession: () => session,
    getWorkflows: vi.fn(async () => []),
    resolveProject: vi.fn(async () => project),
    getEnvironment: () => ({ name: "dev" }) as ResolvedEnvironment,
    loadSystemPrompt,
  };
  const readChild = vi.fn((id: string) => store.readChild(id));
  const assertCurrent = vi.fn(async () => {
    hosted.signal.throwIfAborted();
  });
  const activated: ActivatedAssistantContextRuntime = {
    start: vi.fn(async () => hosted.server),
    assertAvailable: vi.fn(async () => {}),
  };
  const build = (
    owner: ActivatedAssistantContextRuntime | undefined = activated,
  ) =>
    createAssistantContextRuntime({
      activated: owner,
      contextOptions,
      assertCurrent,
      continuations: { readChild },
    });
  const runtime = build();
  const compose = (accepted: AcceptedAssistantContext) =>
    runtime.delivery.compose(
      hosted,
      "ses_child",
      accepted,
      { attemptToken: randomUUID() },
      abort.signal,
    );
  return {
    hosted,
    session,
    project,
    store,
    runtime,
    activated,
    build,
    abort,
    readChild,
    loadSystemPrompt,
    contextOptions,
    compose,
    receipt: () => receipt,
    accept: () =>
      runtime.delivery.accept(hosted, "ses_child", null, abort.signal),
    prepare: async () => {
      const candidate = await runtime.resolveCandidate(
        hosted,
        null,
        abort.signal,
      );
      receipt = await store.update(receipt, {
        phase: "accepting",
        frozenCandidate: freezeContinuationCandidate(
          candidate,
          receipt.childBinding!,
          receipt.acceptanceId,
        ),
      });
      const accepted = await runtime.delivery.acceptFrozen(
        hosted,
        "ses_child",
        candidate,
        receipt.acceptanceId,
        abort.signal,
      );
      const ref = {
        schemaVersion: accepted.schemaVersion,
        acceptanceId: accepted.acceptanceId,
        authorityScope: accepted.authorityScope,
        conversationId: accepted.conversationId,
        revision: accepted.revision,
      };
      receipt = await store.update(receipt, {
        acceptedRef: ref,
        phase: "seeding",
      });
      receipt = await store.update(receipt, { phase: "prepared" });
      return accepted;
    },
  };
}
const wire = (system: string) => {
  const parsed = parseStudioAssistantSystem(system);
  if (parsed.kind !== "accepted-v2")
    throw new Error("Expected accepted context");
  return parsed.wire;
};

it("keeps legacy dispatch without activation, supports exact inline Resume and refuses accepted execution", async () => {
  const f = await fixture(),
    runtime = f.runtime;
  const inactive = createAssistantContextRuntime({
    contextOptions: f.contextOptions,
    assertCurrent: async () => {},
    continuations: { readChild: f.readChild },
  });
  expect(typeof inactive.context).toBe("function");
  await expect(inactive.assertAvailable()).rejects.toMatchObject({
    failure: { code: "context_unavailable" },
  });
  await expect(
    inactive.resolveCandidate(f.hosted, null, f.abort.signal),
  ).rejects.toThrow("context");
  expect(f.loadSystemPrompt).not.toHaveBeenCalled();
  expect(f.readChild).not.toHaveBeenCalled();
  if (typeof inactive.context !== "function")
    throw new Error("Expected legacy resolver");
  const saved = composeAssistantPrompt(
    await inactive.context(f.hosted, null, f.abort.signal),
  ).system;
  const accepted = await runtime.delivery.accept(
    f.hosted,
    "ses_child",
    null,
    f.abort.signal,
  );
  const typed = await f.compose(accepted);
  f.loadSystemPrompt.mockRejectedValue(
    new Error("Current profile unavailable"),
  );
  const recovered = await inactive.delivery.recover(
    f.hosted,
    "ses_child",
    saved,
    f.abort.signal,
  );
  const parsed = parseStudioAssistantSystem(recovered.system);
  expect(parsed.kind).toBe("legacy-inline-v1");
  expect(recovered.system).toContain("ORIGINAL_PROFILE_BYTES");
  await expect(
    inactive.delivery.recover(
      f.hosted,
      "ses_child",
      typed.system,
      f.abort.signal,
    ),
  ).rejects.toMatchObject({ failure: { code: "context_unavailable" } });
  expect(f.hosted.server.fetch).not.toHaveBeenCalled();
});

it("shares one delivery, preserves default missing-loader facts, and writes the approved scoped owner path", async () => {
  const f = await fixture();
  expect(f.runtime.context).toBe(f.runtime.delivery);
  const accepted = await f.accept();
  expect(accepted.context.session.id).toBe(f.receipt().childStudioId);
  const sources = accepted.instructionSet.sources;
  expect(
    sources
      .filter((source) => source.status === "not-configured")
      .map((source) => source.id),
  ).toEqual(["project-instructions", "sapiom-agent-authoring"]);
  const continuation = sources.find(
    (source) => source.kind === "continuation",
  )!;
  expect(continuation).toMatchObject({
    authorityScope: f.hosted.contextAuthorityScope,
    contentHash: f.receipt().brief.sha256,
    required: true,
  });
  expect(
    sources.every(
      (source) => source.authorityScope === f.hosted.contextAuthorityScope,
    ),
  ).toBe(true);
  const retained = join(
    f.hosted.stateRoot,
    "assistant-context",
    "v1",
    f.hosted.contextAuthorityScope,
  );
  expect(
    await readFile(join(retained, "objects", f.receipt().brief.sha256), "utf8"),
  ).toBe(f.receipt().brief.text);
  await expect(stat(join(root, "assistant-context"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    wire((await f.compose(accepted)).system).stable.guidance.some(
      (source) => source.text === f.receipt().brief.text,
    ),
  ).toBe(true);
});

it("adds the frozen child brief to every later Send while ordinary guidance and acceptance advance", async () => {
  const f = await fixture(),
    prepared = await f.prepare();
  const first = wire((await f.compose(prepared)).system);
  f.loadSystemPrompt.mockResolvedValue("UPDATED_CURRENT_PROFILE");
  const next = await f.accept(),
    sent = wire((await f.compose(next)).system);
  expect(next.acceptanceId).not.toBe(prepared.acceptanceId);
  expect(sent.context.session.id).toBe(f.receipt().childStudioId);
  expect(
    sent.stable.guidance.some(
      (source) => source.text === f.receipt().brief.text,
    ),
  ).toBe(true);
  expect(JSON.stringify(sent)).toContain("UPDATED_CURRENT_PROFILE");
  expect(JSON.stringify(first)).toContain("ORIGINAL_PROFILE_BYTES");
  const brief = (value: typeof first) =>
    value.stable.sourceManifest.sources.find(
      (source) => source.kind === "continuation",
    );
  expect(brief(sent)).toEqual(brief(first));
  expect(
    f.readChild.mock.calls.every(([id]) => id === f.receipt().childStudioId),
  ).toBe(true);
});

it("leaves ordinary sessions without continuation guidance", async () => {
  const f = await fixture();
  f.readChild.mockResolvedValue(null);
  const accepted = await f.accept();
  expect(
    accepted.instructionSet.sources.some(
      (source) => source.kind === "continuation",
    ),
  ).toBe(false);
  expect(
    accepted.instructionSet.sources.filter(
      (source) => source.status === "not-configured",
    ),
  ).toHaveLength(2);
});

it("recovers through the source owner after engine loss and refuses missing committed source without live fallback", async () => {
  const f = await fixture(),
    accepted = await f.prepare();
  const original = wire((await f.compose(accepted)).system),
    saved = (await f.compose(accepted)).system;
  await rm(join(f.hosted.stateRoot, "engine"), { recursive: true });
  f.loadSystemPrompt.mockRejectedValue(new Error("Live provider must not run"));
  f.readChild.mockClear();
  const restarted = f.build();
  expect(
    wire(
      (
        await restarted.delivery.recover(
          f.hosted,
          "ses_child",
          saved,
          f.abort.signal,
        )
      ).system,
    ).accepted,
  ).toEqual(original.accepted);
  expect(f.readChild).not.toHaveBeenCalled();
  await rm(
    join(
      f.hosted.stateRoot,
      "assistant-context",
      "v1",
      f.hosted.contextAuthorityScope,
      "objects",
      f.receipt().brief.sha256,
    ),
  );
  await expect(
    restarted.delivery.recover(f.hosted, "ses_child", saved, f.abort.signal),
  ).rejects.toThrow("context");
  expect(f.readChild).not.toHaveBeenCalled();
  expect(f.hosted.server.fetch).not.toHaveBeenCalled();
});

it("preserves trusted instruction/capability loaders and appends only the child-scoped continuation", async () => {
  const f = await fixture();
  const owner = {
    ...f.activated,
    loadCapabilities: vi.fn(async () => [
      { name: "verified", status: "available" as const, tools: ["read"] },
    ]),
    loadGuidance: vi.fn(async (_context, hosted: HostedOpenCode) => [
      retainAssistantGuidance(
        {
          id: "instructions",
          kind: "project",
          required: true,
          source: "trusted:project",
          revision: null,
          status: "available",
          text: "EXACT_OWNER_INSTRUCTION\r\n",
        },
        hosted.contextAuthorityScope,
      ),
    ]),
  };
  const runtime = f.build(owner),
    accepted = await runtime.delivery.accept(
      f.hosted,
      "ses_child",
      null,
      f.abort.signal,
    );
  expect(accepted.context.capabilities).toEqual([
    { name: "verified", status: "available", tools: ["read"] },
  ]);
  expect(owner.loadGuidance.mock.calls[0]![0]).toMatchObject({
    session: { id: f.hosted.harnessSessionId, projectId: "project" },
  });
  const system = wire(
    (
      await runtime.delivery.compose(
        f.hosted,
        "ses_child",
        accepted,
        { attemptToken: randomUUID() },
        f.abort.signal,
      )
    ).system,
  );
  expect(
    system.stable.guidance.some(
      (source) => source.text === "EXACT_OWNER_INSTRUCTION\r\n",
    ),
  ).toBe(true);
  expect(
    system.stable.guidance.some(
      (source) => source.text === f.receipt().brief.text,
    ),
  ).toBe(true);
});

it("does not claim accepted skills are executable without their managed generation", async () => {
  const f = await fixture();
  const metadata = {
    id: "package",
    kind: "skill" as const,
    source: "trusted:package",
    required: true,
    status: "available" as const,
    revision: null,
  };
  const skill = createAssistantSource(
    { ...metadata, authorityScope: f.hosted.contextAuthorityScope },
    {
      format: "skill-package",
      bytes: encodeAssistantSkillPackage([
        {
          path: "SKILL.md",
          executable: false,
          bytes: Buffer.from("# Owned package"),
        },
      ]),
    },
  );
  const runtime = f.build({
    ...f.activated,
    loadGuidance: async () => [{ metadata, ...skill }],
  });
  const accepted = await runtime.delivery.accept(
    f.hosted,
    "ses_child",
    null,
    f.abort.signal,
  );
  await expect(
    runtime.delivery.compose(
      f.hosted,
      "ses_child",
      accepted,
      { attemptToken: randomUUID() },
      f.abort.signal,
    ),
  ).rejects.toThrow("context");
  expect(f.hosted.server.fetch).not.toHaveBeenCalled();
});

it.each(["scope", "child", "hash", "unassociated"])(
  "fails closed on %s mismatch in trusted continuation lookup",
  async (change) => {
    const f = await fixture(),
      receipt = structuredClone(f.receipt());
    if (change === "scope")
      receipt.childBinding!.contextAuthorityScope = "d".repeat(64);
    if (change === "child")
      Object.assign(receipt, { childStudioId: randomUUID() });
    if (change === "hash") receipt.brief.text += "changed";
    if (change === "unassociated")
      Object.assign(receipt, { childBinding: null });
    f.readChild.mockResolvedValue(receipt);
    await expect(f.accept()).rejects.toThrow("context");
    await expect(
      stat(join(f.hosted.stateRoot, "assistant-context")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("does not read current child guidance during a cancelled activation check", async () => {
  const f = await fixture();
  let release!: () => void;
  vi.mocked(f.activated.assertAvailable).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.runtime.resolveCandidate(f.hosted, null, f.abort.signal);
  const rejected = expect(pending).rejects.toThrow("ended");
  await vi.waitFor(() =>
    expect(f.activated.assertAvailable).toHaveBeenCalled(),
  );
  f.abort.abort(new Error("ended"));
  await rejected;
  release();
  expect(f.loadSystemPrompt).not.toHaveBeenCalled();
  expect(f.readChild).not.toHaveBeenCalled();
});
