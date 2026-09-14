import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantSessionStore } from "./assistant-session-store.js";
import {
  AssistantStorageCommitUnconfirmedError,
  writeAssistantJson,
} from "./assistant-session-files.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: vi.fn(fs.open),
    rename: vi.fn(fs.rename),
    rm: vi.fn(fs.rm),
  };
});
let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  if (root) await actual.rm(root, { recursive: true, force: true });
});

it("preserves uncertain publication proof when rollback and temporary cleanup also fail", async () => {
  root = await fs.mkdtemp(join(tmpdir(), "assistant-files-"));
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  const destination = join(root, "lifecycle.json");
  const prior = { lifecycleRevision: 1 };
  const next = {
    lifecycleRevision: 2,
    resumeOperation: { operationId: "retained-proof" },
  };
  await actual.writeFile(destination, JSON.stringify(prior));
  let published = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(from).endsWith(".rollback")) throw new Error("rollback failed");
    await actual.rename(from, to);
    if (to === destination) published = true;
  });
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    if (flags === "r" && published)
      throw Object.assign(new Error("durability failed"), { code: "EIO" });
    return actual.open(path, flags, mode);
  });
  const removed: unknown[] = [];
  vi.mocked(fs.rm).mockImplementation(async (path) => {
    removed.push(path);
    throw new Error("cleanup failed");
  });

  await expect(
    writeAssistantJson(root, "lifecycle.json", next),
  ).rejects.toBeInstanceOf(AssistantStorageCommitUnconfirmedError);
  expect(removed).toHaveLength(3);
  expect(JSON.parse(await actual.readFile(destination, "utf8"))).toEqual(next);
  expect(
    JSON.parse(await actual.readFile(`${destination}.previous`, "utf8")),
  ).toEqual(prior);
});

it("preserves a pre-publication failure when temporary cleanup fails", async () => {
  root = await fs.mkdtemp(join(tmpdir(), "assistant-files-"));
  const primary = Object.assign(new Error("write failed"), { code: "ENOSPC" });
  vi.mocked(fs.open).mockRejectedValue(primary);
  vi.mocked(fs.rm).mockRejectedValue(new Error("cleanup failed"));
  await expect(writeAssistantJson(root, "lifecycle.json", {})).rejects.toBe(
    primary,
  );
});

it("reports temporary cleanup failure after an otherwise successful publication", async () => {
  root = await fs.mkdtemp(join(tmpdir(), "assistant-files-"));
  const cleanup = new Error("cleanup failed");
  vi.mocked(fs.rm).mockRejectedValue(cleanup);
  await expect(
    writeAssistantJson(root, "lifecycle.json", { revision: 1 }),
  ).rejects.toBe(cleanup);
  expect(
    JSON.parse(await fs.readFile(join(root, "lifecycle.json"), "utf8")),
  ).toEqual({ revision: 1 });
});

it.each(["EPERM", "EINVAL", "ENOTSUP"])(
  "supports metadata when directory fsync is unavailable: %s",
  async (code) => {
    root = await fs.mkdtemp(join(tmpdir(), "assistant-files-"));
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      if (flags === "r")
        throw Object.assign(new Error("unsupported"), { code });
      return actual.open(file, flags, mode);
    });
    const store = new AssistantSessionStore(root);
    const saved = await store.transition("studio-a", 0, {
      lifecycle: "ended",
      execution: "paused",
    });
    expect(await store.lifecycle("studio-a")).toEqual(saved);
  },
);

it("propagates real directory IO errors while preserving the previous checkpoint", async () => {
  root = await fs.mkdtemp(join(tmpdir(), "assistant-files-"));
  const store = new AssistantSessionStore(root);
  const saved = await store.transition("studio-a", 0, {
    lifecycle: "ended",
    execution: "paused",
  });
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
    if (flags === "r")
      throw Object.assign(new Error("disk failure"), { code: "EIO" });
    return actual.open(file, flags, mode);
  });
  await expect(
    store.transition("studio-a", 1, {
      lifecycle: "open",
      execution: "enabled",
    }),
  ).rejects.toThrow();
  vi.mocked(fs.open).mockImplementation(actual.open);
  expect(await store.lifecycle("studio-a")).toEqual(saved);
});

it("keeps the prior generation recoverable after post-rename fsync failure and restart", async () => {
  root = await fs.mkdtemp(join(tmpdir(), "assistant-files-"));
  const store = new AssistantSessionStore(root);
  const saved = await store.transition("studio-a", 0, {
    lifecycle: "ended",
    execution: "paused",
  });
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  const file = join(root, "assistant-sessions", "studio-a", "lifecycle.json");
  let failSync = false,
    injected = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await actual.rename(from, to);
    if (to === file && !injected) {
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
  await expect(
    store.transition("studio-a", 1, {
      lifecycle: "open",
      execution: "enabled",
    }),
  ).rejects.toThrow();
  expect(await store.lifecycle("studio-a")).toEqual(saved);
  expect(JSON.parse(await actual.readFile(`${file}.previous`, "utf8"))).toEqual(
    saved,
  );
  await actual.rm(file);
  expect(await new AssistantSessionStore(root).lifecycle("studio-a")).toEqual(
    saved,
  );
});
