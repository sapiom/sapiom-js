import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AssistantSessionStore,
  assistantResumeBindingDigest,
  type AssistantAssociation,
} from "./assistant-session-store.js";
import { parseAssistantLifecycle } from "../shared/assistant-session.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

let root: string, store: AssistantSessionStore;
const id = "studio-a";
const binding: AssistantAssociation = {
  version: 1,
  harnessSessionId: id,
  cwd: "/workspace",
  conversationId: "ses_saved",
  contextAuthorityScope: "a".repeat(64),
  nativeScope: "b".repeat(64),
  createdAt: 1,
};
const request = {
  operationId: "f1872aaa-b7c0-44f1-a9bc-3f9613b4a52c",
  expectedRevision: 1,
  bindingDigest: assistantResumeBindingDigest(binding),
};
const document = () => join(root, "assistant-sessions", id, "lifecycle.json");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-resume-store-"));
  store = new AssistantSessionStore(root);
  await store.transition(id, 0, { lifecycle: "ended", execution: "paused" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("atomically retains Resume proof while exposing only the strict public lifecycle", async () => {
  const state = await store.commitResume(id, 1, request, "paused");
  expect(state).toMatchObject({
    lifecycle: "open",
    execution: "paused",
    revision: 2,
  });
  expect(parseAssistantLifecycle(state)).toEqual(state);
  const raw = JSON.parse(await readFile(document(), "utf8"));
  expect(raw).toEqual({
    ...state,
    resumeOperation: { ...request, version: 1, committedRevision: 2 },
  });
  expect(parseAssistantLifecycle(raw)).toBeNull();
  const restarted = new AssistantSessionStore(root);
  expect(await restarted.lifecycle(id)).toEqual(state);
  expect(await restarted.resumeState(id)).toEqual({
    lifecycle: state,
    resumeOperation: raw.resumeOperation,
  });
});

it("serializes concurrent duplicate commits and returns their exact committed revision", async () => {
  const [a, b] = await Promise.all([
    store.commitResume(id, 1, request, "paused"),
    new AssistantSessionStore(root).commitResume(id, 1, request, "paused"),
  ]);
  expect(a).toEqual(b);
  expect(a.revision).toBe(2);
  expect(await store.lifecycle(id)).toEqual(a);
});

it("reconciles crash-after-commit with a paused CAS from the proved committed revision", async () => {
  await store.commitResume(id, 1, request, "paused");
  const restarted = new AssistantSessionStore(root);
  const recovered = await restarted.resumeState(id);
  const state = await restarted.commitResume(
    id,
    recovered.resumeOperation!.committedRevision,
    request,
    "paused",
  );
  expect(state).toMatchObject({ revision: 3, execution: "paused" });
  expect((await restarted.resumeState(id)).resumeOperation).toEqual({
    ...request,
    version: 1,
    committedRevision: 3,
  });
});

it("rejects an exact original-base replay that requests different execution", async () => {
  const saved = await store.commitResume(id, 1, request, "paused");
  await expect(store.commitResume(id, 1, request, "enabled")).rejects.toThrow(
    "changed",
  );
  expect(await store.lifecycle(id)).toEqual(saved);
});

it("reconciles the original Resume proof after publication and rollback both fail", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let published = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(from).endsWith(".rollback"))
      throw Object.assign(new Error("rollback refused"), { code: "EIO" });
    await actual.rename(from, to);
    if (to === document()) published = true;
  });
  vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
    if (published && flags === "r")
      throw Object.assign(new Error("durability unknown"), { code: "EIO" });
    return actual.open(file, flags, mode);
  });
  await expect(
    store.commitResume(id, 1, request, "paused"),
  ).rejects.toMatchObject({ code: "ASSISTANT_STORAGE_COMMIT_UNCONFIRMED" });
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  const previous = JSON.parse(await readFile(`${document()}.previous`, "utf8"));
  expect(previous).toMatchObject({ revision: 1, lifecycle: "ended" });
  const restarted = new AssistantSessionStore(root);
  expect(await restarted.commitResume(id, 1, request, "paused")).toMatchObject({
    revision: 2,
    lifecycle: "open",
    execution: "paused",
  });
  expect((await restarted.resumeState(id)).resumeOperation).toMatchObject({
    operationId: request.operationId,
    committedRevision: 2,
  });
});

it.each(["ending", "ended", "enabled"] as const)(
  "preserves proof but rejects operation replay after a later %s transition",
  async (next) => {
    await store.commitResume(id, 1, request, "paused");
    const lifecycle = next === "enabled" ? "open" : next;
    const advanced = await store.transition(id, 2, {
      lifecycle,
      execution: next === "enabled" ? "enabled" : "paused",
    });
    expect((await store.resumeState(id)).resumeOperation?.operationId).toBe(
      request.operationId,
    );
    await expect(store.commitResume(id, 1, request, "paused")).rejects.toThrow(
      "changed",
    );
    await expect(
      store.commitResume(id, advanced.revision, request, "paused"),
    ).rejects.toThrow("changed");
    expect(await store.lifecycle(id)).toEqual(advanced);
  },
);

it.each(["bindingDigest", "expectedRevision"] as const)(
  "rejects operation ID reuse with changed %s",
  async (field) => {
    await store.commitResume(id, 1, request, "paused");
    const changed = {
      ...request,
      [field]: field === "bindingDigest" ? "c".repeat(64) : 0,
    };
    await expect(store.commitResume(id, 2, changed, "paused")).rejects.toThrow(
      "changed",
    );
    expect((await store.lifecycle(id))?.revision).toBe(2);
  },
);

it("competing operation IDs cannot both claim the same source revision", async () => {
  const outcomes = await Promise.allSettled([
    store.commitResume(id, 1, request, "paused"),
    new AssistantSessionStore(root).commitResume(
      id,
      1,
      { ...request, operationId: "ac243472-d1ef-4926-bf47-2a32bd28e912" },
      "paused",
    ),
  ]);
  expect(
    outcomes.filter((outcome) => outcome.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    outcomes.filter((outcome) => outcome.status === "rejected"),
  ).toHaveLength(1);
  expect((await store.lifecycle(id))?.revision).toBe(2);
});

it("cancellation preserves the prior header and proof together", async () => {
  const before = await readFile(document(), "utf8");
  await expect(
    store.commitResume(id, 1, request, "paused", AbortSignal.abort()),
  ).rejects.toThrow();
  expect(await readFile(document(), "utf8")).toBe(before);
  expect((await store.resumeState(id)).resumeOperation).toBeNull();
});

it("rolls back header and proof together after failed publication, then safely retries", async () => {
  const previous = await store.resumeState(id);
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let failSync = false;
  let injected = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await actual.rename(from, to);
    if (to === document() && !injected) {
      failSync = true;
      injected = true;
    }
  });
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    if (flags === "r" && failSync) {
      failSync = false;
      throw Object.assign(new Error("post-publication disk failure"), {
        code: "EIO",
      });
    }
    return actual.open(path, flags, mode);
  });
  await expect(store.commitResume(id, 1, request, "paused")).rejects.toThrow(
    "disk failure",
  );
  const restarted = new AssistantSessionStore(root);
  expect(await restarted.resumeState(id)).toEqual(previous);
  const recovered = await restarted.commitResume(id, 1, request, "paused");
  expect(recovered.revision).toBe(2);
  expect((await restarted.resumeState(id)).resumeOperation).toEqual({
    ...request,
    version: 1,
    committedRevision: 2,
  });
});

it("only an already-enabled open lifecycle may preserve enabled execution", async () => {
  await expect(store.commitResume(id, 1, request, "enabled")).rejects.toThrow();
  await store.transition(id, 1, { lifecycle: "open", execution: "enabled" });
  expect(
    await store.commitResume(
      id,
      2,
      { ...request, expectedRevision: 2 },
      "enabled",
    ),
  ).toMatchObject({ revision: 3, execution: "enabled" });
});

it.each([
  { committedRevision: 99 },
  { committedRevision: 1 },
  { bindingDigest: "bad" },
  { operationId: "../escape" },
  { extra: true },
])(
  "rejects malformed or contradictory private operation proof: %j",
  async (patch) => {
    const lifecycle = await store.commitResume(id, 1, request, "paused");
    await writeFile(
      document(),
      JSON.stringify({
        ...lifecycle,
        resumeOperation: {
          ...request,
          version: 1,
          committedRevision: 2,
          ...patch,
        },
      }),
    );
    await expect(store.lifecycle(id)).rejects.toThrow("storage");
    await expect(store.resumeState(id)).rejects.toThrow("storage");
  },
);

it("digests the complete validated association and rejects untrusted extra fields", () => {
  for (const [field, value] of Object.entries(binding)) {
    if (field === "version") continue;
    const replacement =
      field === "createdAt"
        ? 2
        : field === "cwd"
          ? "/other"
          : field.endsWith("Scope")
            ? "f".repeat(64)
            : `${value}_other`;
    expect(
      assistantResumeBindingDigest({ ...binding, [field]: replacement }),
    ).not.toBe(request.bindingDigest);
  }
  expect(() =>
    assistantResumeBindingDigest({
      ...binding,
      extra: true,
    } as AssistantAssociation),
  ).toThrow();
});
