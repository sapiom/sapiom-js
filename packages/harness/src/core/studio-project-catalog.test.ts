import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  StudioProjectCatalog,
  StudioProjectCatalogError,
} from "./studio-project-catalog.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

describe("StudioProjectCatalog", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture() {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "studio-project-catalog-"),
    );
    roots.push(root);
    return { root, catalogPath: path.join(root, "studio-projects.json") };
  }

  it("allocates one durable identity and publishes only path-free summaries", async () => {
    const { root, catalogPath } = await fixture();
    const projectRoot = path.join(root, "market-research");
    await fs.mkdir(projectRoot);
    const catalog = new StudioProjectCatalog(catalogPath);

    const first = await catalog.reconcile([
      { workspaceKey: "workspace-legacy-one", cwd: projectRoot },
      { workspaceKey: "workspace-duplicate", cwd: `${projectRoot}/.` },
    ]);
    const restarted = new StudioProjectCatalog(catalogPath);
    const second = await restarted.reconcile([
      { workspaceKey: "workspace-legacy-one", cwd: projectRoot },
    ]);

    expect(first.projects).toHaveLength(1);
    expect(second.projects[0]?.projectId).toBe(first.projects[0]?.projectId);
    expect(second.workspaceScopes[0]?.projectId).toBe(
      first.projects[0]?.projectId,
    );
    expect(JSON.stringify(second.projects)).not.toContain(projectRoot);
    expect(JSON.stringify(second.projects)).not.toContain("workspace-legacy");
  });

  it("resolves cwd containment to the most-specific active project without paths", async () => {
    const { root, catalogPath } = await fixture();
    const parent = path.join(root, "workspace");
    const child = path.join(parent, "nested");
    await fs.mkdir(child, { recursive: true });
    const catalog = new StudioProjectCatalog(catalogPath);
    const reconciled = await catalog.reconcile([
      { workspaceKey: "parent", cwd: parent },
      { workspaceKey: "child", cwd: child },
    ]);
    const parentProject = reconciled.workspaceScopes.find(({ cwd }) => cwd === parent)?.projectId;
    const childProject = reconciled.workspaceScopes.find(({ cwd }) => cwd === child)?.projectId;
    expect((await catalog.resolveIdentityForPath(path.join(child, "src")))?.projectId).toBe(
      childProject,
    );
    expect((await catalog.resolveIdentityForPath(path.join(parent, "other")))?.projectId).toBe(
      parentProject,
    );
    expect(JSON.stringify(await catalog.resolveIdentityForPath(child))).not.toContain(root);
  });

  it("keeps project identity across a root move and an additional repository binding", async () => {
    const { root, catalogPath } = await fixture();
    const originalRoot = path.join(root, "old-name");
    const movedRoot = path.join(root, "new-name");
    const secondRoot = path.join(root, "publisher");
    await Promise.all(
      [originalRoot, movedRoot, secondRoot].map((dir) => fs.mkdir(dir)),
    );
    const catalog = new StudioProjectCatalog(catalogPath);
    const initial = await catalog.reconcile([
      { workspaceKey: "workspace-old", cwd: originalRoot },
    ]);
    const project = initial.projects[0]!;
    const binding = project.bindings[0]!;

    const moved = await catalog.moveRootBinding(
      project.projectId,
      binding.id,
      movedRoot,
      "workspace-new",
    );
    const expanded = await catalog.addRootBinding(
      project.projectId,
      secondRoot,
      {
        repositoryId: "repo_publisher",
        legacyWorkspaceKey: "workspace-publisher",
      },
    );

    expect(moved.projectId).toBe(project.projectId);
    expect(expanded.projectId).toBe(project.projectId);
    expect(expanded.bindings).toHaveLength(2);
    expect(JSON.stringify(expanded)).not.toContain("repo_publisher");
    expect(
      (
        JSON.parse(await fs.readFile(catalogPath, "utf8")) as {
          projects: Array<{
            rootBindings: Array<{ repositoryId: string | null }>;
          }>;
        }
      ).projects[0]?.rootBindings.map((entry) => entry.repositoryId),
    ).toContain("repo_publisher");

    const restarted = await new StudioProjectCatalog(catalogPath).reconcile([
      { workspaceKey: "workspace-new", cwd: movedRoot },
      { workspaceKey: "workspace-publisher", cwd: secondRoot },
    ]);
    expect(restarted.projects).toHaveLength(1);
    expect(restarted.projects[0]?.projectId).toBe(project.projectId);
    expect(restarted.workspaceScopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: project.projectId }),
        expect.objectContaining({ projectId: project.projectId }),
      ]),
    );
  });

  it("serializes concurrent writers from independent catalog instances", async () => {
    const { root, catalogPath } = await fixture();
    const alpha = path.join(root, "alpha");
    const beta = path.join(root, "beta");
    await Promise.all([fs.mkdir(alpha), fs.mkdir(beta)]);

    const [first, second] = await Promise.all([
      new StudioProjectCatalog(catalogPath).reconcile([
        { workspaceKey: "workspace-alpha", cwd: alpha },
      ]),
      new StudioProjectCatalog(catalogPath).reconcile([
        { workspaceKey: "workspace-beta", cwd: beta },
      ]),
    ]);
    const reconciled = await new StudioProjectCatalog(catalogPath).reconcile([
      { workspaceKey: "workspace-alpha", cwd: alpha },
      { workspaceKey: "workspace-beta", cwd: beta },
    ]);

    expect(reconciled.projects).toHaveLength(2);
    expect(
      new Set(reconciled.workspaceScopes.map((scope) => scope.projectId)),
    ).toEqual(
      new Set([
        first.workspaceScopes[0]?.projectId,
        second.workspaceScopes[0]?.projectId,
      ]),
    );
  });

  it("fences three writers while reclaiming a dead owner without leaking lock artifacts", async () => {
    const { catalogPath } = await fixture();
    const lockPath = `${catalogPath}.lock`;
    const deadPid = process.pid + 100_000;
    await fs.writeFile(
      lockPath,
      JSON.stringify({ ownerId: "abandoned-owner", pid: deadPid }),
    );

    const bothDelayedObserved = deferred();
    const resumeDelayed = deferred();
    const winnerAcquired = deferred();
    const releaseWinner = deferred();
    const delayedObservedReplacement = deferred();
    let deadObservations = 0;
    const delayedHooks = {
      isPidAlive: (pid: number) => pid === process.pid,
      afterDeadOwnerObserved: async () => {
        deadObservations += 1;
        if (deadObservations === 2) bothDelayedObserved.resolve();
        await resumeDelayed.promise;
      },
      afterObservedOwnerChanged: () => {
        delayedObservedReplacement.resolve();
      },
      afterLiveOwnerObserved: () => {
        delayedObservedReplacement.resolve();
      },
    };
    const delayedB = new StudioProjectCatalog(
      catalogPath,
      () => new Date(),
      delayedHooks,
    );
    const delayedC = new StudioProjectCatalog(
      catalogPath,
      () => new Date(),
      delayedHooks,
    );
    const winner = new StudioProjectCatalog(
      catalogPath,
      () => new Date(),
      {
        isPidAlive: (pid) => pid === process.pid,
        afterLockAcquired: async () => {
          winnerAcquired.resolve();
          await releaseWinner.promise;
        },
      },
    );

    const writeB = delayedB.create("Writer B");
    const writeC = delayedC.create("Writer C");
    await bothDelayedObserved.promise;
    const writeA = winner.create("Writer A");
    await winnerAcquired.promise;
    resumeDelayed.resolve();
    await delayedObservedReplacement.promise;
    releaseWinner.resolve();

    await Promise.all([writeA, writeB, writeC]);
    const restarted = await new StudioProjectCatalog(catalogPath).list();
    expect(restarted.map((project) => project.displayName).sort()).toEqual([
      "Writer A",
      "Writer B",
      "Writer C",
    ]);
    expect(
      (await fs.readdir(path.dirname(catalogPath))).filter((entry) =>
        entry.startsWith(`${path.basename(catalogPath)}.lock`),
      ),
    ).toEqual([]);
  });

  it("never evicts a slow live PID even when its lock mtime is old", async () => {
    const { catalogPath } = await fixture();
    const lockPath = `${catalogPath}.lock`;
    const liveAcquired = deferred();
    const releaseLive = deferred();
    const waiterObservedLive = deferred();
    let waiterSettled = false;
    const live = new StudioProjectCatalog(catalogPath, () => new Date(), {
      afterLockAcquired: async () => {
        liveAcquired.resolve();
        await releaseLive.promise;
      },
    });
    const waiter = new StudioProjectCatalog(catalogPath, () => new Date(), {
      afterLiveOwnerObserved: () => {
        waiterObservedLive.resolve();
      },
    });

    const liveWrite = live.create("Slow live writer");
    await liveAcquired.promise;
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);
    const waiterWrite = waiter.create("Patient writer").finally(() => {
      waiterSettled = true;
    });
    await waiterObservedLive.promise;
    expect(waiterSettled).toBe(false);
    releaseLive.resolve();

    await Promise.all([liveWrite, waiterWrite]);
    expect(
      (await new StudioProjectCatalog(catalogPath).list()).map(
        (project) => project.displayName,
      ).sort(),
    ).toEqual(["Patient writer", "Slow live writer"]);
    expect(
      (await fs.readdir(path.dirname(catalogPath))).filter((entry) =>
        entry.startsWith(`${path.basename(catalogPath)}.lock`),
      ),
    ).toEqual([]);
  });

  it("preserves unsafe live scopes without Agent Map assignment and accepts legal path whitespace", async () => {
    const { root, catalogPath } = await fixture();
    const spaced = path.join(root, "project ");
    await fs.mkdir(spaced);

    const reconciled = await new StudioProjectCatalog(catalogPath).reconcile([
      { workspaceKey: "workspace-unsafe", cwd: `${root}/bad\npath` },
      { workspaceKey: "workspace-spaced", cwd: spaced },
    ]);

    expect(reconciled.projects).toHaveLength(1);
    expect(reconciled.projects[0]?.displayName).toBe("project");
    expect(reconciled.workspaceScopes).toEqual(
      expect.arrayContaining([
        {
          workspaceKey: "workspace-unsafe",
          cwd: `${root}/bad\npath`,
        },
        expect.objectContaining({ cwd: spaced }),
      ]),
    );
    expect(
      reconciled.workspaceScopes.find(
        (scope) => scope.workspaceKey === "workspace-unsafe",
      ),
    ).not.toHaveProperty("projectId");
  });

  it("keeps every conflicting legacy-key root unassigned in both orders and after restart", async () => {
    const { root, catalogPath } = await fixture();
    const alpha = path.join(root, "alpha");
    const beta = path.join(root, "beta");
    await Promise.all([fs.mkdir(alpha), fs.mkdir(beta)]);
    const forwardScopes = [
      { workspaceKey: "shared-legacy-key", cwd: alpha },
      { workspaceKey: "shared-legacy-key", cwd: beta },
    ];

    const forward = await new StudioProjectCatalog(catalogPath).reconcile(
      forwardScopes,
    );
    const reversed = await new StudioProjectCatalog(catalogPath).reconcile(
      [...forwardScopes].reverse(),
    );

    for (const result of [forward, reversed]) {
      expect(result.projects).toEqual([]);
      expect(result.workspaceScopes).toEqual(
        expect.arrayContaining(forwardScopes),
      );
      expect(result.workspaceScopes).toHaveLength(2);
      expect(
        result.workspaceScopes.every(
          (scope) => !Object.prototype.hasOwnProperty.call(scope, "projectId"),
        ),
      ).toBe(true);
    }
    expect(await new StudioProjectCatalog(catalogPath).list()).toEqual([]);
  });

  it("rejects a move onto another binding in the same project and remains restart-readable", async () => {
    const { root, catalogPath } = await fixture();
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    await Promise.all([fs.mkdir(firstRoot), fs.mkdir(secondRoot)]);
    const catalog = new StudioProjectCatalog(catalogPath);
    const project = (
      await catalog.reconcile([
        { workspaceKey: "workspace-first", cwd: firstRoot },
      ])
    ).projects[0]!;
    await catalog.addRootBinding(project.projectId, secondRoot, {
      legacyWorkspaceKey: "workspace-second",
    });

    await expect(
      catalog.moveRootBinding(
        project.projectId,
        project.bindings[0]!.id,
        secondRoot,
      ),
    ).rejects.toMatchObject({ code: "malformed_state" });

    const restarted = await new StudioProjectCatalog(catalogPath).resolve(
      project.projectId,
    );
    expect(restarted?.bindings).toHaveLength(2);
  });

  it("supports a project with no repository binding", async () => {
    const { catalogPath } = await fixture();
    const project = await new StudioProjectCatalog(catalogPath).create(
      "Empty project",
    );
    expect(project.bindings).toEqual([]);
    expect(
      (await new StudioProjectCatalog(catalogPath).resolve(project.projectId))
        ?.projectId,
    ).toBe(project.projectId);
  });

  it("distinguishes malformed, unsupported, and unavailable catalog storage", async () => {
    const malformed = await fixture();
    await fs.writeFile(malformed.catalogPath, "{not-json");
    await expect(
      new StudioProjectCatalog(malformed.catalogPath).list(),
    ).rejects.toMatchObject({
      code: "malformed_state",
    } satisfies Partial<StudioProjectCatalogError>);

    const future = await fixture();
    await fs.writeFile(
      future.catalogPath,
      JSON.stringify({ schemaVersion: 99, projects: [], futureField: true }),
    );
    await expect(
      new StudioProjectCatalog(future.catalogPath).list(),
    ).rejects.toMatchObject({
      code: "unsupported_schema",
    } satisfies Partial<StudioProjectCatalogError>);

    const unavailable = await fixture();
    await fs.writeFile(unavailable.root + "/not-a-directory", "file");
    await expect(
      new StudioProjectCatalog(
        unavailable.root + "/not-a-directory/catalog.json",
      ).create("Project"),
    ).rejects.toMatchObject({
      code: "storage_unavailable",
    } satisfies Partial<StudioProjectCatalogError>);
  });
});
