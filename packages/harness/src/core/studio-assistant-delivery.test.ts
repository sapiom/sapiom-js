import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assistantContentHash,
  assistantContextLimits,
  parseStudioAssistantSystem,
  studioAssistantCompletionSystem,
} from "@sapiom/opencode";
import { createAssistantContextDelivery } from "./studio-assistant-delivery.js";
import { FileAssistantSourceStore } from "./assistant-source-store.js";
import { createAssistantContextCandidate } from "./assistant-sources.js";
import { composeAssistantPrompt } from "./studio-assistant-context.js";
import {
  sourceContext,
  sourceScope,
  acceptanceId,
} from "./test-fixtures/assistant-context.js";
import {
  OpenCodeTransportError,
  type HostedOpenCode,
} from "./opencode-host.js";
import { openCodeTransportFailure } from "../shared/opencode-errors.js";

let root: string;
const roots: string[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-delivery-"));
  roots.push(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function fixture() {
  const abort = new AbortController();
  const hosted: HostedOpenCode = {
    harnessSessionId: "studio-a",
    cwd: root,
    stateRoot: root,
    contextAuthorityScope: sourceScope,
    model: "smart",
    signal: abort.signal,
    isCurrent: () => !abort.signal.aborted,
    server: {
      pid: 1,
      exited: new Promise(() => {}),
      close: vi.fn(),
      fetch: vi.fn(),
      fetchJson: vi.fn(),
    },
  };
  const context = sourceContext();
  context.session.cwd = root;
  const agents = ["a", "b"].map((name) => ({
    name,
    path: join(root, name),
    definitionId: null,
  }));
  context.agents = agents;
  const store = new FileAssistantSourceStore(root, sourceScope);
  const assertCurrent = vi.fn(async () => {
    if (!hosted.isCurrent())
      throw new OpenCodeTransportError(
        openCodeTransportFailure("access_denied"),
      );
  });
  const resolveContext = vi.fn(async (_hosted, selection) => {
    context.selectedAgent =
      selection == null
        ? { status: "none" }
        : {
            status: "available",
            agent: agents.find((agent) => agent.path === selection)!,
          };
    return createAssistantContextCandidate(context, sourceScope);
  });
  const prepareRuntime = vi.fn<
    Parameters<typeof createAssistantContextDelivery>[0]["prepareRuntime"]
  >(async () => {});
  const delivery = createAssistantContextDelivery({
    resolveContext,
    storeFor: () => store,
    assertCurrent,
    prepareRuntime,
  });
  const signal = new AbortController().signal;
  const accept = () =>
    delivery.accept(hosted, "ses_fixture", agents[0]!.path, signal);
  return {
    hosted,
    context,
    store,
    assertCurrent,
    resolveContext,
    prepareRuntime,
    delivery,
    signal,
    accept,
    abort,
    agents,
  };
}
function legacySystem(context: ReturnType<typeof sourceContext>) {
  const revision = assistantContentHash(
    JSON.stringify({ ...context, revision: undefined }),
  );
  return composeAssistantPrompt({ ...context, revision }).system;
}
const typed = (system: string) => {
  const parsed = parseStudioAssistantSystem(system);
  if (parsed.kind !== "accepted-v2") throw new Error("Expected typed context");
  return parsed.wire;
};
describe("accepted Assistant context delivery", () => {
  it("retains selection and exact source bytes across new sends, store restart and recovery", async () => {
    const f = fixture();
    const accepted = await f.accept();
    const first = await f.delivery.compose(
      f.hosted,
      accepted,
      { attemptToken: acceptanceId },
      f.signal,
    );
    f.context.guidance[0]!.text = "New profile";
    const next = await f.delivery.accept(
      f.hosted,
      "ses_fixture",
      f.agents[1]!.path,
      f.signal,
    );
    const store = new FileAssistantSourceStore(root, sourceScope);
    const resolveContext = vi.fn(() => {
      throw new Error("Recovery cannot fetch current guidance");
    });
    const restarted = createAssistantContextDelivery({
      resolveContext,
      storeFor: () => store,
      assertCurrent: f.assertCurrent,
      prepareRuntime: f.prepareRuntime,
    });
    const recovered = typed(
      (await restarted.recover(f.hosted, "ses_fixture", first.system, f.signal))
        .system,
    );
    expect(recovered.accepted.acceptanceId).toBe(accepted.acceptanceId);
    expect(recovered.accepted.revision).toBe(accepted.revision);
    expect(recovered.attemptToken).not.toBe(acceptanceId);
    expect(recovered.stable).toEqual(typed(first.system).stable);
    expect(recovered.context.selectedAgent).toEqual({
      status: "available",
      agent: f.agents[0],
    });
    expect(next.acceptanceId).not.toBe(accepted.acceptanceId);
    expect(next.instructionSet.revision).not.toBe(
      accepted.instructionSet.revision,
    );
    expect(f.resolveContext).toHaveBeenCalledTimes(2);
    expect(resolveContext).not.toHaveBeenCalled();
    expect(f.hosted.server.fetch).not.toHaveBeenCalled();
  });
  it("budgets the complete saved prompt before committing acceptance", async () => {
    const f = fixture();
    f.context.guidance[0]!.text = "x".repeat(
      assistantContextLimits.bytes - 6000,
    );
    expect(() =>
      createAssistantContextCandidate(f.context, sourceScope),
    ).not.toThrow();
    const retain = vi.spyOn(f.store, "retainAccepted");
    await expect(f.accept()).rejects.toMatchObject({
      failure: { code: "context_unavailable" },
    });
    expect(retain).not.toHaveBeenCalled();
    f.context.guidance[0]!.text = "Fits the full envelope";
    const accepted = await f.accept();
    const prompt = await f.delivery.compose(
      f.hosted,
      accepted,
      { attemptToken: acceptanceId },
      f.signal,
    );
    expect(typed(prompt.system).accepted.acceptanceId).toBe(
      accepted.acceptanceId,
    );
  });
  it("requires every accepted material on readback and never refetches missing optional content", async () => {
    const f = fixture();
    f.context.guidance.push({
      ...f.context.guidance[0]!,
      id: "optional",
      required: false,
      kind: "project",
      text: "Optional accepted text",
    });
    const accepted = await f.accept();
    const { system } = await f.delivery.compose(
      f.hosted,
      accepted,
      { attemptToken: acceptanceId },
      f.signal,
    );
    const source = accepted.instructionSet.sources.find(
      (source) => source.id === "optional",
    )!;
    await rm(
      join(
        root,
        "assistant-context",
        "v1",
        sourceScope,
        "objects",
        source.contentHash!,
      ),
    );
    await expect(
      f.delivery.recover(f.hosted, "ses_fixture", system, f.signal),
    ).rejects.toMatchObject({ failure: { code: "context_unavailable" } });
    expect(f.resolveContext).toHaveBeenCalledOnce();
  });
  it("rejects foreign session, workspace, authority and native conversation references", async () => {
    const f = fixture();
    const accepted = await f.accept();
    const { system } = await f.delivery.compose(
      f.hosted,
      accepted,
      { attemptToken: acceptanceId },
      f.signal,
    );
    for (const hosted of [
      { ...f.hosted, harnessSessionId: "studio-b" },
      { ...f.hosted, cwd: join(root, "other") },
      { ...f.hosted, contextAuthorityScope: "b".repeat(64) },
    ])
      await expect(
        f.delivery.recover(hosted, "ses_fixture", system, f.signal),
      ).rejects.toMatchObject({ failure: { code: "context_unavailable" } });
    await expect(
      f.delivery.recover(f.hosted, "ses_other", system, f.signal),
    ).rejects.toMatchObject({ failure: { code: "context_unavailable" } });
  });
  it.each(["resolve", "retain", "read", "readiness"])(
    "rejects revocation during %s and preserves the typed access failure",
    async (phase) => {
      const f = fixture();
      const denied = new OpenCodeTransportError(
        openCodeTransportFailure("access_denied"),
      );
      const revoke = () => f.assertCurrent.mockRejectedValue(denied);
      if (phase === "resolve")
        f.resolveContext.mockImplementationOnce(async () => {
          revoke();
          return createAssistantContextCandidate(f.context, sourceScope);
        });
      if (phase === "retain") {
        const retain = f.store.retainAccepted.bind(f.store);
        vi.spyOn(f.store, "retainAccepted").mockImplementation(
          async (...args) => {
            await retain(...args);
            revoke();
          },
        );
      }
      if (["resolve", "retain"].includes(phase)) {
        await expect(f.accept()).rejects.toBe(denied);
        return;
      }
      const accepted = await f.accept();
      if (phase === "read") {
        const read = f.store.readAccepted.bind(f.store);
        vi.spyOn(f.store, "readAccepted").mockImplementation(
          async (...args) => {
            const retained = await read(...args);
            revoke();
            return retained;
          },
        );
      } else
        f.prepareRuntime.mockImplementationOnce(async () => {
          revoke();
        });
      await expect(
        f.delivery.compose(
          f.hosted,
          accepted,
          { attemptToken: acceptanceId },
          f.signal,
        ),
      ).rejects.toBe(denied);
    },
  );
  it("passes cancellation through resolver, store and readiness without accepting a partial result", async () => {
    const f = fixture();
    const accepted = await f.accept();
    expect(f.resolveContext).toHaveBeenCalledWith(
      f.hosted,
      f.agents[0]!.path,
      f.signal,
    );
    const controller = new AbortController();
    const read = vi.spyOn(f.store, "readAccepted");
    f.prepareRuntime.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled admission"));
    });
    await expect(
      f.delivery.compose(
        f.hosted,
        accepted,
        { attemptToken: acceptanceId },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled admission");
    expect(read.mock.calls[0]![2]).toBe(controller.signal);
    expect(f.prepareRuntime.mock.calls.at(-1)?.[2]).toBe(controller.signal);
  });
  it("fails closed on unsupported runtime preparation and keeps typed native-history errors", async () => {
    const f = fixture();
    const accepted = await f.accept();
    f.prepareRuntime.mockRejectedValueOnce(
      new Error("private runtime generation details"),
    );
    await expect(
      f.delivery.compose(
        f.hosted,
        accepted,
        { attemptToken: acceptanceId },
        f.signal,
      ),
    ).rejects.toMatchObject({ failure: { code: "context_unavailable" } });
    const missing = new OpenCodeTransportError(
      openCodeTransportFailure("native_history_missing"),
    );
    f.resolveContext.mockRejectedValueOnce(missing);
    await expect(f.accept()).rejects.toBe(missing);
  });
  it("preserves only validated legacy inline payloads and never creates an accepted manifest", async () => {
    const f = fixture();
    const legacy = legacySystem(f.context);
    const retain = vi.spyOn(f.store, "retainAccepted");
    const read = vi.spyOn(f.store, "readAccepted");
    const recovered = parseStudioAssistantSystem(
      (await f.delivery.recover(f.hosted, "ses_fixture", legacy, f.signal))
        .system,
    );
    const original = parseStudioAssistantSystem(legacy);
    expect(recovered.kind).toBe("legacy-inline-v1");
    if (
      recovered.kind !== "legacy-inline-v1" ||
      original.kind !== "legacy-inline-v1"
    )
      throw new Error("Expected legacy");
    expect(recovered.suffix).toBe(original.suffix);
    expect(recovered.completionToken).not.toBe(original.completionToken);
    expect(retain).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(f.resolveContext).not.toHaveBeenCalled();
  });
  it("rejects context-free, malformed and location-only legacy recovery instead of acquiring new content", async () => {
    const f = fixture();
    f.context.guidance.push({
      id: "skill",
      kind: "skill",
      required: true,
      source: "old",
      revision: null,
      status: "available",
      location: "/mutable/skill",
    });
    for (const saved of [
      undefined,
      studioAssistantCompletionSystem(acceptanceId),
      legacySystem(f.context),
      legacySystem(f.context).slice(0, -1),
    ])
      await expect(
        f.delivery.recover(f.hosted, "ses_fixture", saved, f.signal),
      ).rejects.toMatchObject({ failure: { code: "context_unavailable" } });
    expect(f.resolveContext).not.toHaveBeenCalled();
  });
});
