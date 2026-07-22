import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InvalidWorkspaceNameError, UnknownWorkspaceError } from "./errors.js";
import { WorkspaceStore } from "./workspace-store.js";

describe("WorkspaceStore", () => {
  let tmpRoot: string;
  let storePath: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-workspace-store-"));
    storePath = path.join(tmpRoot, "state", "workspaces.json");
    store = new WorkspaceStore(storePath);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("starts empty when no store file exists", async () => {
    expect(await store.list()).toEqual([]);
  });

  describe("create", () => {
    it("creates an empty workspace with a stable id and timestamps", async () => {
      const ws = await store.create("acme-crm");
      expect(ws.name).toBe("acme-crm");
      expect(ws.agentPaths).toEqual([]);
      expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(ws.createdAt).toBe(ws.updatedAt);
      expect(await store.list()).toEqual([ws]);
    });

    it("trims the name and rejects empty / whitespace-only names", async () => {
      const ws = await store.create("  spaced  ");
      expect(ws.name).toBe("spaced");
      await expect(store.create("")).rejects.toBeInstanceOf(InvalidWorkspaceNameError);
      await expect(store.create("   ")).rejects.toBeInstanceOf(InvalidWorkspaceNameError);
    });

    it("assigns a distinct id to each workspace, even with the same name", async () => {
      const a = await store.create("dupe");
      const b = await store.create("dupe");
      expect(a.id).not.toBe(b.id);
      expect(await store.list()).toHaveLength(2);
    });
  });

  describe("rename", () => {
    it("renames in place (same id) and bumps updatedAt", async () => {
      const ws = await store.create("old", "2020-01-01T00:00:00.000Z");
      const renamed = await store.rename(ws.id, "  new  ", "2020-01-02T00:00:00.000Z");
      expect(renamed.id).toBe(ws.id);
      expect(renamed.name).toBe("new");
      expect(renamed.createdAt).toBe("2020-01-01T00:00:00.000Z");
      expect(renamed.updatedAt).toBe("2020-01-02T00:00:00.000Z");
    });

    it("throws UnknownWorkspaceError for an unknown id", async () => {
      await expect(store.rename("nope", "x")).rejects.toBeInstanceOf(UnknownWorkspaceError);
    });

    it("rejects an empty new name", async () => {
      const ws = await store.create("keep");
      await expect(store.rename(ws.id, "  ")).rejects.toBeInstanceOf(InvalidWorkspaceNameError);
      expect((await store.list())[0].name).toBe("keep");
    });
  });

  describe("remove", () => {
    it("deletes a workspace and persists the deletion", async () => {
      const a = await store.create("a");
      const b = await store.create("b");
      await store.remove(a.id);
      expect((await store.list()).map((w) => w.id)).toEqual([b.id]);

      const reloaded = new WorkspaceStore(storePath);
      expect((await reloaded.list()).map((w) => w.id)).toEqual([b.id]);
    });

    it("throws UnknownWorkspaceError for an unknown id", async () => {
      await expect(store.remove("nope")).rejects.toBeInstanceOf(UnknownWorkspaceError);
    });
  });

  describe("assignAgent / unassignAgent", () => {
    it("assigns agents by path in order and bumps updatedAt", async () => {
      const ws = await store.create("w", "2020-01-01T00:00:00.000Z");
      await store.assignAgent(ws.id, "/repos/crm-manager", "2020-01-02T00:00:00.000Z");
      const after = await store.assignAgent(ws.id, "/repos/lead-handler", "2020-01-03T00:00:00.000Z");
      expect(after.agentPaths).toEqual(["/repos/crm-manager", "/repos/lead-handler"]);
      expect(after.updatedAt).toBe("2020-01-03T00:00:00.000Z");
    });

    it("assign is idempotent — no duplicate and no updatedAt bump", async () => {
      const ws = await store.create("w", "2020-01-01T00:00:00.000Z");
      await store.assignAgent(ws.id, "/repos/a", "2020-01-02T00:00:00.000Z");
      const again = await store.assignAgent(ws.id, "/repos/a", "2020-01-09T00:00:00.000Z");
      expect(again.agentPaths).toEqual(["/repos/a"]);
      expect(again.updatedAt).toBe("2020-01-02T00:00:00.000Z");
    });

    it("unassigns a member and is a no-op for a non-member", async () => {
      const ws = await store.create("w", "2020-01-01T00:00:00.000Z");
      await store.assignAgent(ws.id, "/repos/a", "2020-01-02T00:00:00.000Z");
      const removed = await store.unassignAgent(ws.id, "/repos/a", "2020-01-03T00:00:00.000Z");
      expect(removed.agentPaths).toEqual([]);
      expect(removed.updatedAt).toBe("2020-01-03T00:00:00.000Z");

      const noop = await store.unassignAgent(ws.id, "/repos/never", "2020-01-09T00:00:00.000Z");
      expect(noop.agentPaths).toEqual([]);
      expect(noop.updatedAt).toBe("2020-01-03T00:00:00.000Z");
    });

    it("throws UnknownWorkspaceError when the workspace is gone", async () => {
      await expect(store.assignAgent("nope", "/repos/a")).rejects.toBeInstanceOf(UnknownWorkspaceError);
      await expect(store.unassignAgent("nope", "/repos/a")).rejects.toBeInstanceOf(UnknownWorkspaceError);
    });
  });

  describe("persistence & stability", () => {
    it("persists workspaces + memberships and reloads them for a fresh instance", async () => {
      const ws = await store.create("acme");
      await store.assignAgent(ws.id, "/repos/crm-manager");
      await store.assignAgent(ws.id, "/repos/enricher");

      const reloaded = new WorkspaceStore(storePath);
      const list = await reloaded.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("acme");
      expect(list[0].agentPaths).toEqual(["/repos/crm-manager", "/repos/enricher"]);
    });

    it("membership survives regardless of any open-session state (nothing recomputes it)", async () => {
      // The store has no session/cwd inputs at all: reloading a persisted file
      // yields exactly what was written, proving membership can never be
      // re-derived from which terminals happen to be open.
      const ws = await store.create("stable");
      await store.assignAgent(ws.id, "/repos/a");
      const reloaded = new WorkspaceStore(storePath);
      expect((await reloaded.list())[0].agentPaths).toEqual(["/repos/a"]);
    });
  });

  describe("write serialization & atomicity", () => {
    it("concurrent creates all survive in the persisted file", async () => {
      const N = 8;
      await Promise.all(Array.from({ length: N }, (_, i) => store.create(`ws-${i}`)));

      const reloaded = new WorkspaceStore(storePath);
      const names = new Set((await reloaded.list()).map((w) => w.name));
      for (let i = 0; i < N; i++) expect(names.has(`ws-${i}`)).toBe(true);
    });

    it("concurrent assigns to the same workspace all survive (no lost update)", async () => {
      const ws = await store.create("w");
      const N = 8;
      await Promise.all(
        Array.from({ length: N }, (_, i) => store.assignAgent(ws.id, `/repos/agent-${i}`)),
      );

      const reloaded = new WorkspaceStore(storePath);
      const paths = new Set((await reloaded.list())[0].agentPaths);
      for (let i = 0; i < N; i++) expect(paths.has(`/repos/agent-${i}`)).toBe(true);
    });

    it("persist uses atomic tmp-file + rename so a mid-write crash cannot tear workspaces.json", async () => {
      await store.create("w");
      const raw = await fs.readFile(storePath, "utf8");
      expect(Array.isArray(JSON.parse(raw))).toBe(true);
      await expect(fs.access(`${storePath}.tmp`)).rejects.toThrow();
    });

    it("a failed persist does not poison the queue — subsequent writes succeed", async () => {
      // Make the store path a DIRECTORY so writeFile throws EISDIR.
      const badPath = path.join(tmpRoot, "workspaces-dir");
      await fs.mkdir(badPath, { recursive: true });
      const broken = new WorkspaceStore(badPath);

      await expect(broken.create("x")).rejects.toThrow();

      await fs.rmdir(badPath);
      await broken.create("ok");
      const list = await broken.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("ok");
    });
  });
});
