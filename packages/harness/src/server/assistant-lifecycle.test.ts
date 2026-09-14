import express from "express";
import { createServer, type Server } from "node:http";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  createAssistantLifecycleRouter,
  projectAssistantContinuation,
} from "./assistant-lifecycle.js";
import {
  OpenCodeAccessError,
  OpenCodeTransportError,
} from "../core/opencode-host.js";
import { AssistantContinuationUnconfirmedError } from "../core/assistant-continuation-native.js";
import {
  AssistantContinuationConflictError,
  type AssistantContinuationReceipt,
} from "../core/assistant-continuation-store.js";
import { openCodeTransportFailure } from "../shared/opencode-errors.js";
import { parseAssistantContinuationView } from "../shared/assistant-continuation.js";
import type { HarnessSession } from "../shared/types.js";

const op = "11111111-1111-4111-8111-111111111111";
let server: Server, origin: string;
const entry = vi.fn(),
  inspect = vi.fn(),
  resume = vi.fn(),
  continuation = vi.fn();
const lifecycle = {
  version: 1,
  harnessSessionId: "studio-a",
  revision: 4,
  lifecycle: "ended",
  execution: "paused",
  updatedAt: 1,
};
const savedEntry = {
  kind: "assistant",
  harnessSessionId: "studio-a",
  cwd: "/workspace",
  title: "Saved",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  lifecycle,
  history: "partial",
  nativeResume: "unchecked",
  recordRevision: 7,
};
const session = {
  id: "studio-a",
  cwd: "/workspace",
  title: "Saved",
  harness: "claude-code",
  status: "exited",
  ready: false,
  createdAt: savedEntry.createdAt,
  lastActiveAt: savedEntry.updatedAt,
} as HarnessSession;
const attachment = {
  conversationId: "ses_original",
  lease: op,
  lifecycle: { ...lifecycle, lifecycle: "open", revision: 5 },
};
const receipt = {
  phase: "prepared",
  operationId: op,
  sourceBinding: {
    harnessSessionId: "studio-a",
    contextAuthorityScope: "private-source-scope",
  },
  sourceRecordRevision: 7,
  childBinding: {
    conversationId: "ses_child",
    contextAuthorityScope: "private-child-scope",
  },
  seedMessageId: "msg_seed",
  seedPartId: "prt_seed",
  brief: {
    capturedAt: savedEntry.updatedAt,
    text: "Recorded brief",
    sha256: "a".repeat(64),
    retainedTurns: 1,
    omittedTurns: 3,
  },
  frozenCandidate: { materials: ["private-input"] },
  acceptedRef: { acceptanceId: "private-acceptance" },
} as unknown as AssistantContinuationReceipt;
const post = (
  action = "inspect",
  body: unknown = { expectedRevision: 4 },
  token = "boot",
) =>
  fetch(`${origin}/sessions/studio-a/assistant/${action}`, {
    method: "POST",
    headers: { "X-Harness-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(async () => {
  entry.mockReset().mockResolvedValue(savedEntry);
  inspect.mockReset().mockResolvedValue({
    nativeHistory: "available",
    nativeResume: "available",
    savedSystem: "private-system",
    sourceMessageId: "private-message",
  });
  resume.mockReset().mockResolvedValue(attachment);
  continuation.mockReset().mockResolvedValue({
    session: { ...session, id: "child", terminalState: "not-started" },
    attachment,
    receipt,
  });
  const app = express();
  app.use(
    createAssistantLifecycleRouter({
      bootToken: "boot",
      history: { entry },
      native: { inspect },
      getSession: () => session,
      resume,
      continue: continuation,
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("requires the boot token before history or native work", async () => {
  for (const action of ["inspect", "resume", "continue"])
    expect((await post(action, {}, "wrong")).status).toBe(401);
  expect(entry).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(continuation).not.toHaveBeenCalled();
});
it("rejects ambiguous bodies, client bindings, invalid revisions and operation IDs", async () => {
  for (const body of [
    [],
    null,
    {},
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: 4, cwd: "/other" },
  ])
    expect((await post("inspect", body)).status).toBe(400);
  expect((await post("inspect?other=1")).status).toBe(400);
  expect(
    (await post("resume", { expectedRevision: 4, operationId: "invalid" }))
      .status,
  ).toBe(400);
  expect(
    (
      await post("continue", {
        expectedRevision: 4,
        operationId: op,
        expectedRecordRevision: 0,
      })
    ).status,
  ).toBe(400);
  expect((await post("unknown")).status).toBe(404);
  expect(inspect).not.toHaveBeenCalled();
});
it("projects selected availability without private saved system or source-message data", async () => {
  const response = await post();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.entry).toEqual({ ...savedEntry, nativeResume: "available" });
  expect(JSON.stringify(body)).not.toContain("private");
  expect(inspect).toHaveBeenCalledWith("studio-a", 4);
});
it("keeps missing native history and unavailable original context separate from readable records", async () => {
  for (const [nativeResume, code] of [
    ["missing", "native_history_missing"],
    ["unavailable", "context_unavailable"],
  ] as const) {
    inspect.mockResolvedValueOnce({
      nativeResume,
      nativeHistory: nativeResume,
      resumeFailure: openCodeTransportFailure(code),
    });
    const response = await post();
    expect(response.status).toBe(200);
    expect((await response.json()).entry).toMatchObject({
      history: "partial",
      nativeResume,
      resumeFailure: { code },
    });
  }
});
it("rejects a stale inspection before startup and a late lifecycle change after native read", async () => {
  expect((await post("inspect", { expectedRevision: 3 })).status).toBe(409);
  expect(inspect).not.toHaveBeenCalled();
  entry.mockResolvedValueOnce(savedEntry).mockResolvedValueOnce({
    ...savedEntry,
    lifecycle: { ...lifecycle, revision: 5 },
  });
  expect((await post()).status).toBe(409);
});
it("returns the same Resume Studio identity and normalizes legacy null fields without starting Terminal", async () => {
  entry
    .mockResolvedValueOnce(savedEntry)
    .mockResolvedValueOnce({ ...savedEntry, lifecycle: attachment.lifecycle });
  const response = await post("resume", {
    expectedRevision: 4,
    operationId: op,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    session: { ...session, agentSessionId: null, boundWorkflowPath: null },
    attachment,
  });
  expect(resume).toHaveBeenCalledWith("studio-a", 4, op);
  expect(continuation).not.toHaveBeenCalled();
});
it("discards Resume when a newer lifecycle or authorization wins before the response", async () => {
  entry.mockResolvedValueOnce(savedEntry).mockResolvedValueOnce({
    ...savedEntry,
    lifecycle: { ...lifecycle, revision: 6 },
  });
  expect(
    (await post("resume", { expectedRevision: 4, operationId: op })).status,
  ).toBe(409);
  entry
    .mockResolvedValueOnce(savedEntry)
    .mockRejectedValueOnce(
      new OpenCodeAccessError("private authorization detail"),
    );
  const response = await post("resume", {
    expectedRevision: 4,
    operationId: op,
  });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("private");
});
it("projects Continue provenance without receipt inputs or accepted-reference authority", async () => {
  const response = await post("continue", {
    expectedRevision: 4,
    expectedRecordRevision: 7,
    operationId: op,
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(
    parseAssistantContinuationView(body.continuation, "ses_child"),
  ).toEqual(projectAssistantContinuation(receipt));
  expect(body.session).toMatchObject({
    id: "child",
    terminalState: "not-started",
    agentSessionId: null,
  });
  expect(JSON.stringify(body)).not.toContain("private");
  expect(continuation).toHaveBeenCalledWith("studio-a", {
    expectedRevision: 4,
    expectedRecordRevision: 7,
    operationId: op,
  });
});
it("returns safe typed uncertainty and conflicts instead of raw storage/native diagnostics", async () => {
  for (const [error, status, code] of [
    [
      new AssistantContinuationUnconfirmedError(),
      409,
      "continuation_unconfirmed",
    ],
    [new AssistantContinuationConflictError(), 409, "lifecycle_changed"],
    [
      new OpenCodeTransportError(
        openCodeTransportFailure("context_unavailable"),
      ),
      503,
      "context_unavailable",
    ],
    [new Error("private storage diagnostics"), 503, "transport_unavailable"],
  ] as const) {
    continuation.mockRejectedValueOnce(error);
    const response = await post("continue", {
      expectedRevision: 4,
      expectedRecordRevision: 7,
      operationId: op,
    });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("private");
  }
});
it("does not publish provenance from an unfinished receipt or accept foreign seed attestations", () => {
  expect(() =>
    projectAssistantContinuation({ ...receipt, phase: "seeding" }),
  ).toThrow(AssistantContinuationUnconfirmedError);
  const view = projectAssistantContinuation(receipt);
  expect(parseAssistantContinuationView(view, "ses_foreign")).toBeNull();
  expect(
    parseAssistantContinuationView({
      ...view,
      seed: { ...view.seed, text: "x".repeat(24_001) },
    }),
  ).toBeNull();
  expect(
    parseAssistantContinuationView({ ...view, operationId: "invalid" }),
  ).toBeNull();
});
