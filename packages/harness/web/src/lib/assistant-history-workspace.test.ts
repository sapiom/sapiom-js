import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { openCodeTransportFailure } from "../../../src/shared/opencode-errors";
import {
  assistantHistoryMatches,
  type AssistantHistoryEntry,
} from "../../../src/shared/assistant-history";
import {
  parseAssistantHistoryEntry,
  readAssistantHistory,
} from "./assistant-history-client";
import {
  inspectAssistant,
  isAssistantLifecycleConflict,
  resumeEntryForSelection,
  resumeAssistantRequest,
} from "./assistant-resume-client";
import {
  continueAssistantRequest,
  prepareContinueRequest,
  savedContinueRequest,
} from "./assistant-continuation-client";

const operationId = "11111111-1111-4111-8111-111111111111";
const workspace = { cwd: "/launch-alias", canonicalCwd: "/canonical" };
const entry: AssistantHistoryEntry = {
  kind: "assistant",
  harnessSessionId: "studio-a",
  title: "Saved",
  cwd: workspace.canonicalCwd,
  workspace,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  lifecycle: {
    version: 1,
    harnessSessionId: "studio-a",
    revision: 2,
    lifecycle: "ended",
    execution: "paused",
    updatedAt: 1,
  },
  history: "available",
  nativeResume: "available",
  recordRevision: 1,
  continuationScope: "a".repeat(64),
};
const signal = () => new AbortController().signal;
const respond = (value: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        }),
    ),
  );
const resumed = () => ({
  workspace,
  session: {
    id: entry.harnessSessionId,
    cwd: workspace.cwd,
    title: entry.title,
    harness: "claude-code",
    agentSessionId: null,
    boundWorkflowPath: null,
    status: "exited",
    ready: false,
    createdAt: entry.createdAt,
    lastActiveAt: entry.updatedAt,
  },
  attachment: {
    lease: operationId,
    conversationId: "ses_saved",
    lifecycle: { ...entry.lifecycle, lifecycle: "open", revision: 3 },
  },
});
afterEach(() => vi.unstubAllGlobals());

it("accepts verified query/launch aliases and keeps legacy exact-cwd compatibility", async () => {
  respond({
    workspace: { cwd: "/query-alias", canonicalCwd: entry.cwd },
    entries: [entry],
  });
  expect(await readAssistantHistory("/query-alias", "boot", signal())).toEqual([
    entry,
  ]);
  const legacy = { ...entry, workspace: undefined };
  respond({ entries: [legacy] });
  expect(await readAssistantHistory(entry.cwd, "boot", signal())).toEqual([
    legacy,
  ]);
});

it.each([
  {
    workspace: { cwd: "/another-query", canonicalCwd: entry.cwd },
    entries: [entry],
  },
  {
    workspace: { cwd: "/query-alias", canonicalCwd: "/foreign" },
    entries: [entry],
  },
  {
    workspace: { cwd: "/query-alias", canonicalCwd: entry.cwd },
    entries: [{ ...entry, workspace: undefined }],
  },
  {
    workspace: { cwd: "/query-alias", canonicalCwd: entry.cwd },
    entries: [
      { ...entry, workspace: { ...workspace, canonicalCwd: "/foreign" } },
    ],
  },
  {
    workspace: { cwd: "/query-alias", canonicalCwd: entry.cwd },
    entries: [{ ...entry, workspace: { cwd: null, canonicalCwd: entry.cwd } }],
  },
  { entries: [entry] },
])(
  "rejects an absent, malformed or mismatched alias proof %#",
  async (value) => {
    respond(value);
    await expect(
      readAssistantHistory("/query-alias", "boot", signal()),
    ).rejects.toThrow("could not be verified");
  },
);

it("only matches the exact Studio and current launch spelling, even if another row spells the canonical path", () => {
  expect(assistantHistoryMatches(entry, "studio-a", workspace.cwd)).toBe(true);
  expect(assistantHistoryMatches(entry, "studio-b", workspace.cwd)).toBe(false);
  expect(assistantHistoryMatches(entry, "studio-a", entry.cwd)).toBe(false);
  expect(assistantHistoryMatches(entry, "studio-a", "/other")).toBe(false);
  expect(
    parseAssistantHistoryEntry({
      ...entry,
      workspace: { ...workspace, canonicalCwd: "/other" },
    }),
  ).toBeNull();
});

it("resumes through the exact verified pair without changing the requested operation tuple", async () => {
  respond(resumed());
  expect(
    (await resumeAssistantRequest(entry, operationId, "boot", signal())).session
      .cwd,
  ).toBe(workspace.cwd);
  const request = vi.mocked(fetch).mock.calls[0]![1]!;
  expect(JSON.parse(request.body as string)).toEqual({
    operationId,
    expectedRevision: 2,
    expectedWorkspace: workspace,
  });
});

it("sends inspected intent even for an older entry with only exact cwd", async () => {
  const legacy = { ...entry, workspace: undefined };
  respond({ entry: legacy });
  await inspectAssistant(legacy, "boot", signal());
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string),
  ).toEqual({
    expectedRevision: 2,
    expectedWorkspace: { cwd: entry.cwd, canonicalCwd: entry.cwd },
  });
});

it("refreshes only Resume transport spelling after re-selection of the same proven binding", () => {
  const selected = {
    ...entry,
    workspace: { ...workspace, cwd: "/alias-b" },
    lifecycle: { ...entry.lifecycle, revision: 8 },
  };
  const retried = resumeEntryForSelection(entry, selected);
  expect(retried).toEqual({ ...entry, workspace: selected.workspace });
  expect(entry.workspace).toEqual(workspace);
  expect(retried.lifecycle).toBe(entry.lifecycle);
  for (const unsafe of [
    { ...selected, continuationScope: undefined },
    { ...selected, continuationScope: "b".repeat(64) },
    { ...selected, cwd: "/different-project" },
    { ...selected, harnessSessionId: "different-studio" },
    { ...selected, workspace: undefined },
  ])
    expect(resumeEntryForSelection(entry, unsafe)).toBe(entry);
  const legacy = { ...entry, continuationScope: undefined };
  expect(
    resumeEntryForSelection(legacy, {
      ...selected,
      continuationScope: undefined,
    }),
  ).toBe(legacy);
});

it.each(["missing", "malformed", "canonical", "raw", "session"])(
  "rejects a %s Resume workspace proof",
  async (change) => {
    const value: Record<string, unknown> = resumed();
    if (change === "missing") delete value.workspace;
    if (change === "malformed") value.workspace = { cwd: 1 };
    if (change === "canonical")
      value.workspace = { ...workspace, canonicalCwd: "/foreign" };
    if (change === "raw") value.workspace = { ...workspace, cwd: entry.cwd };
    if (change === "session")
      value.session = { ...resumed().session, cwd: entry.cwd };
    respond(value);
    await expect(
      resumeAssistantRequest(entry, operationId, "boot", signal()),
    ).rejects.toThrow("could not be verified");
  },
);

it("rejects an inspection whose launch alias changes within the same canonical directory", async () => {
  respond({
    entry: { ...entry, workspace: { ...workspace, cwd: "/new-alias" } },
  });
  await expect(inspectAssistant(entry, "boot", signal())).rejects.toThrow(
    "could not be verified",
  );
});

it("verifies a Continue child against the source launch spelling without substituting its canonical path", async () => {
  const child = resumed();
  child.session.id = "child";
  child.attachment.lifecycle.harnessSessionId = "child";
  const value = {
    ...child,
    session: {
      ...child.session,
      agentMapIdentity: { projectId: "p", userId: "u", sessionId: "child" },
    },
    continuation: {
      operationId,
      sourceSessionId: entry.harnessSessionId,
      sourceRecordRevision: 1,
      capturedAt: entry.updatedAt,
      retainedTurns: 1,
      omittedTurns: 0,
      seed: {
        conversationId: "ses_saved",
        messageId: "msg_seed",
        partId: "prt_seed",
        text: "Seed",
        sha256: createHash("sha256").update("Seed").digest("hex"),
      },
    },
  };
  const request = {
    operationId,
    expectedRevision: 2,
    expectedRecordRevision: 1,
  };
  respond(value);
  expect(
    (await continueAssistantRequest(entry, request, "boot", signal())).session
      .cwd,
  ).toBe(workspace.cwd);
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string),
  ).toEqual({ ...request, expectedWorkspace: workspace });
  expect(request).toEqual({
    operationId,
    expectedRevision: 2,
    expectedRecordRevision: 1,
  });
  value.session.cwd = entry.cwd;
  respond(value);
  await expect(
    continueAssistantRequest(entry, request, "boot", signal()),
  ).rejects.toThrow("could not be verified");
});

it("retains a persisted uncertain Continue tuple after a workspace preflight conflict", async () => {
  const key = `studio.assistant-continue.v1:${entry.continuationScope}:${entry.harnessSessionId}`;
  const request = {
    operationId,
    expectedRevision: 2,
    expectedRecordRevision: 1,
  };
  const storage = new Map([[key, JSON.stringify(request)]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, callback: () => unknown) => callback(),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: openCodeTransportFailure("workspace_changed"),
          }),
          { status: 409 },
        ),
    ),
  );
  const pending = await prepareContinueRequest(entry, 99);
  const error = await continueAssistantRequest(
    entry,
    pending,
    "boot",
    signal(),
  ).catch((error: unknown) => error);
  expect(error).toMatchObject({
    status: 409,
    failure: { code: "workspace_changed" },
  });
  expect(isAssistantLifecycleConflict(error)).toBe(false);
  expect(savedContinueRequest(entry)).toEqual(request);
  expect(storage.get(key)).toBe(JSON.stringify(request));
  expect(
    await prepareContinueRequest(
      { ...entry, lifecycle: { ...entry.lifecycle, revision: 10 } },
      99,
    ),
  ).toEqual(request);
});
