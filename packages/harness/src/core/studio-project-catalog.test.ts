import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  StudioProjectCatalog,
  StudioProjectCatalogError,
} from "./studio-project-catalog.js";

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
    expect(expanded.bindings.map((entry) => entry.repositoryId)).toContain(
      "repo_publisher",
    );
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
