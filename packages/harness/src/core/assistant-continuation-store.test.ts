import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  AssistantContinuationStore,
  ASSISTANT_CONTINUATION_MAX_BYTES,
  freezeContinuationCandidate,
  thawContinuationCandidate,
  type AssistantContinuationPatch,
  type AssistantContinuationReceipt,
} from "./assistant-continuation-store.js";
import { projectAssistantRecord } from "./assistant-record.js";
import {
  acceptedAssistantRecord,
  createAssistantContextCandidate,
} from "./assistant-sources.js";
import { sourceContext } from "./test-fixtures/assistant-context.js";
import * as files from "./assistant-session-files.js";

vi.mock("./assistant-session-files.js", async (original) => {
  const files = await original<typeof import("./assistant-session-files.js")>();
  return { ...files, writeAssistantJson: vi.fn(files.writeAssistantJson) };
});
const binding = {
  harnessSessionId: "studio-parent",
  cwd: "/workspace",
  conversationId: "ses_parent",
  contextAuthorityScope: "a".repeat(64),
};
const operation = "11111111-1111-4111-8111-111111111111";
let root: string, store: AssistantContinuationStore;
const record = () =>
  projectAssistantRecord(
    [
      {
        info: {
          id: "msg_user",
          role: "user",
          sessionID: "ses_parent",
          time: { created: 1 },
        },
        parts: [
          {
            id: "prt_text",
            messageID: "msg_user",
            sessionID: "ses_parent",
            type: "text",
            text: "Preserve the current result.",
          },
        ],
      },
    ],
    binding,
    7,
  );
const load = vi.fn(async () => record());
const reserve = () => store.reserve(binding, 7, 3, operation, load);
const receiptPath = () =>
  join(
    root,
    "assistant-sessions",
    binding.harnessSessionId,
    "bindings",
    binding.contextAuthorityScope,
    `continuation-${operation}.json`,
  );
const linkPath = (id: string) =>
  join(root, "assistant-sessions", id, "continuation-preparation.json");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "continuation-receipt-"));
  store = new AssistantContinuationStore(root);
  load.mockReset().mockImplementation(async () => record());
  const actual = await vi.importActual<typeof files>(
    "./assistant-session-files.js",
  );
  vi.mocked(files.writeAssistantJson)
    .mockReset()
    .mockImplementation(actual.writeAssistantJson);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function advanceTo(target: AssistantContinuationReceipt["phase"]) {
  let receipt = await reserve();
  const child = {
    ...binding,
    harnessSessionId: receipt.childStudioId,
    conversationId: "ses_child",
    contextAuthorityScope: "b".repeat(64),
  };
  const context = sourceContext();
  context.session.id = child.harnessSessionId;
  context.guidance.push({
    id: "continuation",
    kind: "continuation",
    required: true,
    source: "studio:record",
    revision: null,
    status: "available",
    text: receipt.brief.text,
  });
  const candidate = createAssistantContextCandidate(
    context,
    child.contextAuthorityScope,
  );
  const frozen = freezeContinuationCandidate(
    candidate,
    child,
    receipt.acceptanceId,
  );
  const ref = {
    schemaVersion: 1 as const,
    acceptanceId: receipt.acceptanceId,
    conversationId: child.conversationId,
    authorityScope: child.contextAuthorityScope,
    revision: acceptedAssistantRecord(
      candidate,
      child.contextAuthorityScope,
      child.conversationId,
      receipt.acceptanceId,
    ).revision,
  };
  const patches: AssistantContinuationPatch[] = [
    { phase: "allocated" },
    { phase: "creating" },
    { phase: "associated", childBinding: child },
    { phase: "accepting", frozenCandidate: frozen },
    { phase: "seeding", acceptedRef: ref },
    { phase: "prepared" },
  ];
  for (const patch of patches) {
    if (receipt.phase === target) break;
    receipt = await store.update(receipt, patch);
  }
  return receipt;
}

it("reserves once across concurrent calls/restart and reads the existing receipt before newer history", async () => {
  const [first, duplicate] = await Promise.all([reserve(), reserve()]);
  expect(duplicate).toEqual(first);
  load.mockRejectedValue(new Error("latest history changed or disappeared"));
  store = new AssistantContinuationStore(root);
  expect(await reserve()).toEqual(first);
  expect(load).toHaveBeenCalledOnce();
  expect(first.childStudioId).not.toBe(binding.harnessSessionId);
  expect(first.seedMessageId).toMatch(/^msg_[a-f0-9]{12}[A-Za-z0-9]{14}$/);
  expect(parseInt(first.seedPartId.slice(4, 16), 16)).toBeGreaterThan(
    parseInt(first.seedMessageId.slice(4, 16), 16),
  );
  expect(
    JSON.parse(await readFile(linkPath(first.childStudioId), "utf8")),
  ).toMatchObject({
    childStudioId: first.childStudioId,
    operationId: operation,
    sourceBinding: binding,
  });
  expect(await store.canAttach(first.childStudioId)).toBe(false);
  expect(await store.readChild(first.childStudioId)).toEqual(first);
  expect(await store.readChild("ordinary-session")).toBeNull();
  expect(await store.canAttach("ordinary-session")).toBe(true);
});

it.each(["record", "lifecycle", "workspace", "conversation"])(
  "rejects different %s reservation inputs without rereading history",
  async (changed) => {
    const first = await reserve();
    const source = {
      ...binding,
      ...(changed === "workspace" ? { cwd: "/other" } : {}),
      ...(changed === "conversation" ? { conversationId: "ses_other" } : {}),
    };
    await expect(
      store.reserve(
        source,
        changed === "record" ? 8 : 7,
        changed === "lifecycle" ? 4 : 3,
        operation,
        load,
      ),
    ).rejects.toThrow();
    expect(load).toHaveBeenCalledOnce();
    expect(await store.read(binding, operation)).toEqual(first);
    expect(
      await store.read(
        { ...binding, contextAuthorityScope: "c".repeat(64) },
        operation,
      ),
    ).toBeNull();
  },
);

it.each(["empty", "missing", "revision"])(
  "does not reserve a child from %s history",
  async (bad) => {
    const source =
      bad === "empty"
        ? projectAssistantRecord([], binding, 7)
        : bad === "missing"
          ? null
          : { ...record(), revision: 8 };
    await expect(
      store.reserve(binding, 7, 3, operation, async () => source),
    ).rejects.toThrow();
    expect(await store.read(binding, operation)).toBeNull();
    expect(files.writeAssistantJson).not.toHaveBeenCalled();
  },
);

it.each(["creating", "seeding"] as const)(
  "retains uncertain %s across restart and forbids a reset or stale CAS",
  async (phase) => {
    const current = await advanceTo(phase);
    store = new AssistantContinuationStore(root);
    expect(await reserve()).toEqual(current);
    await expect(
      store.update(current, { phase: "allocated" }),
    ).rejects.toThrow();
    const next = await store.update(
      current,
      phase === "creating"
        ? {
            phase: "associated",
            childBinding: {
              ...binding,
              harnessSessionId: current.childStudioId,
              conversationId: "ses_child",
              contextAuthorityScope: "b".repeat(64),
            },
          }
        : { phase: "prepared" },
    );
    await expect(store.update(current, { phase })).rejects.toThrow("changed");
    expect(next.revision).toBe(current.revision + 1);
    expect(await store.canAttach(current.childStudioId)).toBe(
      phase === "seeding",
    );
  },
);

it("freezes child inputs and reference once, and keeps prepared admission tied to the exact receipt", async () => {
  const current = await advanceTo("prepared");
  expect(await store.canAttach(current.childStudioId)).toBe(true);
  const candidate = thawContinuationCandidate(
    current.frozenCandidate!,
    current.childBinding!,
    current.acceptanceId,
  );
  candidate.context.environment = "changed";
  const changed = freezeContinuationCandidate(
    candidate,
    current.childBinding!,
    current.acceptanceId,
  );
  for (const patch of [
    { childBinding: null },
    { acceptedRef: null },
    { frozenCandidate: changed },
    { phase: "creating" },
    { acceptanceId: operation },
    { brief: { ...current.brief, text: "changed" } },
  ])
    await expect(
      store.update(current, patch as AssistantContinuationPatch),
    ).rejects.toThrow();
  expect(await store.read(binding, operation)).toEqual(current);
  await rm(receiptPath());
  await rm(`${receiptPath()}.previous`);
  await expect(store.readChild(current.childStudioId)).rejects.toThrow();
  expect(await store.canAttach(current.childStudioId)).toBe(false);
});

it("rejects a valid child candidate whose continuation is not this frozen brief", async () => {
  const current = await advanceTo("associated");
  const context = sourceContext();
  context.session.id = current.childStudioId;
  context.guidance.push({
    id: "continuation",
    kind: "continuation",
    required: true,
    source: "studio:record",
    revision: null,
    status: "available",
    text: "Unrelated recorded brief",
  });
  const candidate = createAssistantContextCandidate(
    context,
    current.childBinding!.contextAuthorityScope,
  );
  const frozen = freezeContinuationCandidate(
    candidate,
    current.childBinding!,
    current.acceptanceId,
  );
  await expect(
    store.update(current, { phase: "accepting", frozenCandidate: frozen }),
  ).rejects.toThrow();
  expect(await store.read(binding, operation)).toEqual(current);
});

it.each(["hash", "seed-id", "accepted-scope", "base64", "size"])(
  "fails closed on corrupt %s receipt data",
  async (bad) => {
    const current = await advanceTo("prepared");
    const invalid = JSON.parse(JSON.stringify(current));
    if (bad === "hash") invalid.brief.sha256 = "0".repeat(64);
    if (bad === "seed-id") invalid.seedMessageId = `msg_${operation}`;
    if (bad === "accepted-scope")
      invalid.acceptedRef.authorityScope = binding.contextAuthorityScope;
    if (bad === "base64")
      invalid.frozenCandidate.materials[0].bytesBase64 = "!!invalid!!";
    if (bad === "size")
      invalid.extra = "x".repeat(ASSISTANT_CONTINUATION_MAX_BYTES);
    await writeFile(receiptPath(), JSON.stringify(invalid));
    await expect(store.read(binding, operation)).rejects.toThrow();
    await expect(store.readChild(current.childStudioId)).rejects.toThrow();
    expect(await store.canAttach(current.childStudioId)).toBe(false);
  },
);

it.each(["before", "after"])(
  "preserves truthful durable state on %s-write update failure",
  async (when) => {
    const current = await advanceTo("allocated");
    const actual = await vi.importActual<typeof files>(
      "./assistant-session-files.js",
    );
    vi.mocked(files.writeAssistantJson).mockImplementationOnce(
      async (...args) => {
        if (when === "after") await actual.writeAssistantJson(...args);
        throw new Error("storage acknowledgement failed");
      },
    );
    await expect(
      store.update(current, { phase: "creating" }),
    ).rejects.toThrow();
    const saved = await new AssistantContinuationStore(root).read(
      binding,
      operation,
    );
    expect(saved?.phase).toBe(when === "after" ? "creating" : "allocated");
    expect(await store.canAttach(current.childStudioId)).toBe(false);
    if (when === "before") expect(saved).toEqual(current);
  },
);

it("repairs a missing child link after interrupted reservation and rejects lookup collisions", async () => {
  const actual = await vi.importActual<typeof files>(
    "./assistant-session-files.js",
  );
  vi.mocked(files.writeAssistantJson).mockImplementation(async (...args) => {
    if (args[1] === "continuation-preparation.json")
      throw new Error("link write failed");
    return actual.writeAssistantJson(...args);
  });
  await expect(reserve()).rejects.toThrow("link write failed");
  const saved = (await store.read(binding, operation))!;
  vi.mocked(files.writeAssistantJson).mockImplementation(
    actual.writeAssistantJson,
  );
  expect(await reserve()).toEqual(saved);
  const link = JSON.parse(
    await readFile(linkPath(saved.childStudioId), "utf8"),
  );
  await writeFile(
    linkPath(saved.childStudioId),
    JSON.stringify({
      ...link,
      operationId: "22222222-2222-4222-8222-222222222222",
    }),
  );
  await expect(reserve()).rejects.toThrow();
  await expect(store.readChild(saved.childStudioId)).rejects.toThrow();
  expect(await store.canAttach(saved.childStudioId)).toBe(false);
  expect(load).toHaveBeenCalledOnce();
});

it("holds an external operation lock while allowing independent receipt CAS", async () => {
  const release = await store.operationLock(binding, operation);
  let second = false;
  const waiting = store.operationLock(binding, operation).then((unlock) => {
    second = true;
    return unlock;
  });
  try {
    const current = await reserve();
    await store.update(current, { phase: "allocated" });
    expect(second).toBe(false);
  } finally {
    await release();
  }
  await (
    await waiting
  )();
});
