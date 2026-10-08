import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LocalWorkspaceScopeCatalog } from "./workspace-scope-catalog.js";

const FIXTURE = path.dirname(fileURLToPath(import.meta.url));

describe("LocalWorkspaceScopeCatalog", () => {
  it("gives a canonical root a stable opaque key and rejects unknown keys", async () => {
    const catalog = new LocalWorkspaceScopeCatalog(() => [
      FIXTURE,
      path.join(FIXTURE, "."),
    ]);
    const scopes = await catalog.list();

    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.workspaceKey).toMatch(/^workspace-[a-f0-9]{16}$/);
    expect(scopes[0]!.workspaceKey).not.toContain(FIXTURE);
    expect((await catalog.resolve(scopes[0]!.workspaceKey))?.root).toBe(
      FIXTURE,
    );
    await expect(catalog.resolve("workspace-not-known")).resolves.toBeNull();
  });

  it("does not collide when two roots share a basename", async () => {
    const catalog = new LocalWorkspaceScopeCatalog(() => [
      "/tmp/one/project",
      "/tmp/two/project",
    ]);
    expect(
      new Set((await catalog.list()).map((scope) => scope.workspaceKey)).size,
    ).toBe(2);
  });

  it("can resolve persisted workspace roots without a live session", async () => {
    const listRoots = vi.fn(async () => [FIXTURE]);
    const catalog = new LocalWorkspaceScopeCatalog(listRoots);
    const [scope] = await catalog.list();

    await expect(catalog.resolve(scope!.workspaceKey)).resolves.toEqual({
      workspaceKey: scope!.workspaceKey,
      root: FIXTURE,
    });
  });
});

