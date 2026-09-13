import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
    isCurrent: () => !abort.signal.aborted,
    server: {
      pid: 123,
      exited: new Promise<void>(() => {}),
      close: vi.fn(),
      fetch: vi.fn(async (path: string) =>
        Response.json({ id: path.split("/").at(-1) }),
      ),
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
  const replacementAbort = new AbortController();
  const replacement = {
    ...hosted,
    signal: replacementAbort.signal,
    isCurrent: () => !replacementAbort.signal.aborted,
  };
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

it("distinguishes confirmed missing history from transient lookup failure without creating a replacement", async () => {
  root = await mkdtemp(join(tmpdir(), "studio-association-"));
  const conversationId = "ses_saved";
  await writeFile(
    join(root, "association.json"),
    JSON.stringify({ version: 1, conversationId }),
  );
  const abort = new AbortController();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("private missing", { status: 404 }))
    .mockRejectedValueOnce(new TypeError("private network diagnostic"))
    .mockResolvedValueOnce(Response.json({ id: conversationId }));
  const create = vi.fn();
  const hosted: HostedOpenCode = {
    harnessSessionId: "studio-one",
    cwd: root,
    stateRoot: root,
    signal: abort.signal,
    isCurrent: () => !abort.signal.aborted,
    server: {
      pid: 123,
      exited: new Promise<void>(() => {}),
      close: vi.fn(),
      fetch,
      fetchJson: create,
    },
  };
  const associations = new OpenCodeAssociations();
  await expect(associations.ensure(hosted)).rejects.toMatchObject({
    failure: { code: "native_history_missing", retryable: false },
  });
  await expect(associations.ensure(hosted)).rejects.toMatchObject({
    failure: { code: "transport_unavailable", retryable: true },
  });
  await expect(associations.ensure(hosted)).resolves.toBe(conversationId);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(create).not.toHaveBeenCalled();
  expect(
    JSON.parse(await readFile(join(root, "association.json"), "utf8")),
  ).toEqual({ version: 1, conversationId });
});
