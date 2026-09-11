import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAssociations } from "./opencode-association.js";
import type { HostedOpenCode } from "./opencode-host.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
let root: string;
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("serializes association commits across runtime retirement, including an already pending rename", async () => {
  root = await mkdtemp(join(tmpdir(), "studio-association-"));
  const original =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let commit!: () => void;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    entered();
    await new Promise<void>((resolve) => {
      commit = resolve;
    });
    await original.rename(from, to);
  });
  let created = 0;
  const abort = new AbortController();
  const hosted: HostedOpenCode = {
    harnessSessionId: "studio-one",
    cwd: root,
    stateRoot: root,
    signal: abort.signal,
    server: {
      pid: 123,
      exited: new Promise<void>(() => {}),
      close: vi.fn(),
      fetch: vi.fn(),
      async fetchJson<T>(path: string): Promise<T> {
        return {
          id: path === "/session" ? `ses_${++created}` : path.split("/").at(-1),
        } as T;
      },
    },
  };
  const associations = new OpenCodeAssociations();
  const old = associations.ensure(hosted);
  await writing;
  abort.abort();
  const replacement = { ...hosted, signal: new AbortController().signal };
  const next = associations.ensure(replacement);
  try {
    expect(created).toBe(1);
    commit();
    const [oldId, newId] = await Promise.all([old, next]);
    expect(newId).toBe(oldId);
    expect(created).toBe(1);
    expect(
      JSON.parse(await readFile(join(root, "association.json"), "utf8"))
        .conversationId,
    ).toBe(newId);
    expect(await associations.ensure(replacement)).toBe(newId);
  } finally {
    commit();
    await Promise.allSettled([old, next]);
  }
});
