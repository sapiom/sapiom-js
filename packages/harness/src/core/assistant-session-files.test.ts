import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantSessionStore } from "./assistant-session-store.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename) };
});
let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
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
