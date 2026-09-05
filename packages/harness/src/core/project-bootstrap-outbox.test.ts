import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectBootstrapOutbox,
  ProjectBootstrapOutboxError,
} from "./project-bootstrap-outbox.js";
import { StudioProjectCatalog } from "./studio-project-catalog.js";

describe("ProjectBootstrapOutbox", () => {
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
      path.join(os.tmpdir(), "project-bootstrap-outbox-"),
    );
    roots.push(root);
    const outbox = new ProjectBootstrapOutbox(path.join(root, "outbox"));
    const lifecycle = {
      beforeProjectsCreatedCommit: (
        projects: Parameters<ProjectBootstrapOutbox["stage"]>[0],
      ) => outbox.stage(projects),
    };
    return {
      root,
      outbox,
      lifecycle,
      catalogPath: path.join(root, "studio-projects.json"),
    };
  }

  it("stages an explicit project before its catalog commit survives a restart", async () => {
    const { catalogPath, lifecycle, outbox } = await fixture();
    const catalog = new StudioProjectCatalog(
      catalogPath,
      undefined,
      undefined,
      lifecycle,
    );

    const project = await catalog.create("Explicit project");
    const restarted = new ProjectBootstrapOutbox(
      path.join(path.dirname(catalogPath), "outbox"),
    );

    expect(await restarted.pending()).toEqual([
      {
        projectId: project.projectId,
        projectCreatedAt: project.createdAt,
      },
    ]);
    await outbox.complete(project.projectId);
    expect(await restarted.pending()).toEqual([]);
  });

  it("ignores a strict stale writer temporary without blocking a valid marker", async () => {
    const { catalogPath, lifecycle } = await fixture();
    const catalog = new StudioProjectCatalog(
      catalogPath,
      undefined,
      undefined,
      lifecycle,
    );
    const project = await catalog.create("Interrupted writer");
    const outboxRoot = path.join(path.dirname(catalogPath), "outbox");
    const staleTemporary = path.join(
      outboxRoot,
      `${project.projectId}.json.tmp-123-${randomUUID()}`,
    );
    await fs.writeFile(staleTemporary, "partial marker", { mode: 0o600 });

    const restarted = new ProjectBootstrapOutbox(outboxRoot);
    await expect(restarted.pending()).resolves.toEqual([
      {
        projectId: project.projectId,
        projectCreatedAt: project.createdAt,
      },
    ]);
    await expect(fs.stat(staleTemporary)).resolves.toBeDefined();
  });

  it("ignores unrelated directory entries without blocking a valid marker or deleting them", async () => {
    const { root, outbox, catalogPath, lifecycle } = await fixture();
    const catalog = new StudioProjectCatalog(catalogPath, undefined, undefined, lifecycle);
    const project = await catalog.create("Pending bootstrap");
    const outboxRoot = path.join(root, "outbox");
    const unrelated = [".DS_Store", "notes.txt", "project-marker.tmp-unknown"];
    for (const name of unrelated) {
      await fs.writeFile(path.join(outboxRoot, name), "unrelated", { mode: 0o600 });
    }
    await fs.mkdir(path.join(outboxRoot, "backups"));

    await expect(outbox.pending()).resolves.toEqual([{
      projectId: project.projectId,
      projectCreatedAt: project.createdAt,
    }]);
    for (const name of [...unrelated, "backups"]) {
      await expect(fs.stat(path.join(outboxRoot, name))).resolves.toBeDefined();
    }
  });

  it.each(["project_invalid.json", `project_${randomUUID()}.json`])(
    "fails closed on malformed reserved project marker %s",
    async (name) => {
      const { root, outbox } = await fixture();
      const outboxRoot = path.join(root, "outbox");
      await fs.mkdir(outboxRoot, { recursive: true });
      const file = path.join(outboxRoot, name);
      await fs.writeFile(file, "malformed reserved state", { mode: 0o600 });

      await expect(outbox.pending()).rejects.toBeInstanceOf(ProjectBootstrapOutboxError);
      await expect(fs.stat(file)).resolves.toBeDefined();
    },
  );

  it("stages only reconcile-created projects and never enrolls a legacy catalog project", async () => {
    const { root, catalogPath, lifecycle, outbox } = await fixture();
    const legacyRoot = path.join(root, "legacy-project");
    const newRoot = path.join(root, "new-project");
    await Promise.all([fs.mkdir(legacyRoot), fs.mkdir(newRoot)]);
    const legacy = await new StudioProjectCatalog(catalogPath).reconcile([
      { workspaceKey: "legacy-root", cwd: legacyRoot },
    ]);
    const legacyProjectId = legacy.projects[0]!.projectId;

    const catalog = new StudioProjectCatalog(
      catalogPath,
      undefined,
      undefined,
      lifecycle,
    );
    const reconciled = await catalog.reconcile([
      { workspaceKey: "legacy-root", cwd: legacyRoot },
      { workspaceKey: "new-root", cwd: newRoot },
    ]);
    const newProjectId = reconciled.workspaceScopes.find(
      (scope) => scope.cwd === newRoot,
    )!.projectId!;

    expect(newProjectId).not.toBe(legacyProjectId);
    expect(await outbox.pending()).toEqual([
      expect.objectContaining({ projectId: newProjectId }),
    ]);
    expect(
      (await outbox.pending()).some(
        (entry) => entry.projectId === legacyProjectId,
      ),
    ).toBe(false);
  });

  it("aborts catalog creation when the write-ahead marker cannot commit", async () => {
    const { catalogPath } = await fixture();
    const catalog = new StudioProjectCatalog(
      catalogPath,
      undefined,
      undefined,
      {
        beforeProjectsCreatedCommit: async () => {
          throw new Error("simulated outbox outage");
        },
      },
    );

    await expect(catalog.create("Must remain absent")).rejects.toThrow(
      "simulated outbox outage",
    );
    expect(await new StudioProjectCatalog(catalogPath).list()).toEqual([]);
  });
});
