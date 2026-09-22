import { promises as fs, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveAgentMapProject } from "./project-resolution.js";
import { StudioProjectCatalog } from "./studio-project-catalog.js";

let root: string;
let stateRoot: string;
let catalogPath: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "shared-map-resolution-"));
  stateRoot = join(root, "custom-state");
  catalogPath = join(stateRoot, "studio-projects.json");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function registered(cwd = join(root, "repo")) {
  const catalog = new StudioProjectCatalog(catalogPath);
  const project = await catalog.create("Project");
  await catalog.addRootBinding(project.projectId, cwd);
  return { catalog, project, cwd };
}

function lookupRepository(cwd: string, projectId?: string) {
  return resolveAgentMapProject({
    kind: "repository",
    stateRoot,
    cwd,
    projectId,
  });
}

it("resolves trusted host and nested repository to the same existing project and custom state path", async () => {
  const { project, cwd, catalog } = await registered();
  const before = await fs.readFile(catalogPath, "utf8");
  const host = await resolveAgentMapProject({
    kind: "host",
    stateRoot,
    projectId: project.projectId,
  });
  const repository = await lookupRepository(join(cwd, "src"));
  expect(repository).toEqual(host);
  expect(host).toMatchObject({
    kind: "resolved",
    projectId: project.projectId,
    workspacePath: join(
      stateRoot,
      "agent-map",
      "projects",
      project.projectId,
      "workspace.json",
    ),
  });
  expect((await catalog.resolveIdentityForPath(cwd))?.projectId).toBe(
    project.projectId,
  );
  expect(await fs.readFile(catalogPath, "utf8")).toBe(before);
  await expect(fs.stat(join(stateRoot, "agent-map"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("leaves unknown repositories and absent catalogs untouched", async () => {
  expect(await lookupRepository(root)).toEqual({ kind: "unregistered" });
  await expect(fs.stat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  const { project } = await registered();
  expect(await lookupRepository(join(root, "other"))).toEqual({
    kind: "unregistered",
  });
  expect(
    await resolveAgentMapProject({
      kind: "host",
      stateRoot,
      projectId: "../bad",
    }),
  ).toEqual({ kind: "unregistered" });
  expect(
    (await new StudioProjectCatalog(catalogPath).list()).map(
      (p) => p.projectId,
    ),
  ).toEqual([project.projectId]);
});

it("uses the most-specific root while an explicit selector scopes lookup", async () => {
  const { catalog, project, cwd } = await registered();
  const nested = await catalog.create("Nested");
  await catalog.addRootBinding(nested.projectId, join(cwd, "nested"));
  const input = {
    kind: "repository" as const,
    stateRoot,
    cwd: join(cwd, "nested", "src"),
  };
  expect(await resolveAgentMapProject(input)).toMatchObject({
    kind: "resolved",
    projectId: nested.projectId,
  });
  expect(
    await resolveAgentMapProject({ ...input, projectId: project.projectId }),
  ).toMatchObject({ kind: "resolved", projectId: project.projectId });
});

it("preserves identity through symlinks and explicitly registered worktree roots", async () => {
  const { catalog, project, cwd } = await registered();
  await fs.mkdir(cwd);
  const alias = join(root, "alias");
  await fs.symlink(cwd, alias, "junction");
  expect(await lookupRepository(join(alias, "src"))).toMatchObject({
    kind: "resolved",
    projectId: project.projectId,
  });
  const worktree = join(root, "worktree");
  expect(await lookupRepository(worktree)).toEqual({ kind: "unregistered" });
  await catalog.addRootBinding(project.projectId, worktree);
  expect(await lookupRepository(worktree)).toMatchObject({
    kind: "resolved",
    projectId: project.projectId,
  });
});

it("reports ambiguous legacy Windows roots and permits an explicit project choice without writes", async () => {
  const { catalog, project } = await registered("C:\\Work\\Project");
  const second = await catalog.create("Second");
  await catalog.addRootBinding(second.projectId, "D:\\Work\\Project");
  const raw = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  raw.projects.find(
    (p: { projectId: string }) => p.projectId === second.projectId,
  ).rootBindings[0].localRootRef = "c:\\work\\project";
  const serialized = JSON.stringify(raw);
  await fs.writeFile(catalogPath, serialized);
  const input = {
    kind: "repository" as const,
    stateRoot,
    cwd: "C:\\Work\\Project\\src",
  };
  expect(await resolveAgentMapProject(input)).toEqual({
    kind: "ambiguous",
    projectIds: [project.projectId, second.projectId].sort(),
  });
  expect(
    await resolveAgentMapProject({ ...input, projectId: second.projectId }),
  ).toMatchObject({ kind: "resolved", projectId: second.projectId });
  expect(await fs.readFile(catalogPath, "utf8")).toBe(serialized);
});

it("discovers an alias created after an unsuccessful repository lookup", async () => {
  const { project, cwd } = await registered();
  await fs.mkdir(cwd);
  const alias = join(root, "alias");
  const input = {
    kind: "repository" as const,
    stateRoot,
    cwd: join(alias, "src"),
  };
  expect(await resolveAgentMapProject(input)).toEqual({ kind: "unregistered" });
  await fs.symlink(cwd, alias, "junction");
  expect(await resolveAgentMapProject(input)).toMatchObject({
    kind: "resolved",
    projectId: project.projectId,
  });
});

it("resolves a retargeted repository alias to its current project", async () => {
  const { catalog, project, cwd } = await registered();
  const secondRoot = join(root, "second");
  const second = await catalog.create("Second");
  await catalog.addRootBinding(second.projectId, secondRoot);
  await fs.mkdir(cwd);
  await fs.mkdir(secondRoot);
  const alias = join(root, "alias");
  await fs.symlink(cwd, alias, "junction");
  const input = {
    kind: "repository" as const,
    stateRoot,
    cwd: join(alias, "src"),
  };
  expect(await resolveAgentMapProject(input)).toMatchObject({
    kind: "resolved",
    projectId: project.projectId,
  });
  await fs.unlink(alias);
  await fs.symlink(secondRoot, alias, "junction");
  expect(await resolveAgentMapProject(input)).toMatchObject({
    kind: "resolved",
    projectId: second.projectId,
  });
});

it("refreshes a root binding registered before its symlink exists", async () => {
  const alias = join(root, "alias");
  const { project } = await registered(alias);
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  await fs.mkdir(firstRoot);
  await fs.mkdir(secondRoot);
  const input = { kind: "repository" as const, stateRoot, cwd: firstRoot };
  expect(await resolveAgentMapProject(input)).toEqual({ kind: "unregistered" });
  await fs.symlink(firstRoot, alias, "junction");
  expect(await resolveAgentMapProject(input)).toMatchObject({
    kind: "resolved",
    projectId: project.projectId,
  });
  await fs.unlink(alias);
  await fs.symlink(secondRoot, alias, "junction");
  expect(await resolveAgentMapProject(input)).toEqual({ kind: "unregistered" });
  expect(
    await resolveAgentMapProject({ ...input, cwd: secondRoot }),
  ).toMatchObject({
    kind: "resolved",
    projectId: project.projectId,
  });
});

it("reports unavailable state for malformed catalogs without rewriting them", async () => {
  await fs.mkdir(stateRoot);
  await fs.writeFile(catalogPath, "broken");
  expect(
    await resolveAgentMapProject({ kind: "repository", stateRoot, cwd: root }),
  ).toEqual({ kind: "unavailable" });
  expect(await fs.readFile(catalogPath, "utf8")).toBe("broken");
  expect(
    await resolveAgentMapProject({
      kind: "repository",
      stateRoot: "",
      cwd: root,
    }),
  ).toEqual({ kind: "unavailable" });
});

it.each(
  ["EACCES", "EPERM", "EIO", "ELOOP"].flatMap((code) =>
    ["cwd", "ancestor", "binding", "unrelated"].map((location) => ({
      code,
      location,
    })),
  ),
)(
  "isolates $code at the $location and preserves ownership errors",
  async ({ code, location }) => {
    const { cwd, catalog, project } = await registered();
    const nested = join(cwd, "nested");
    await fs.mkdir(nested, { recursive: true });
    const blocked = location === "unrelated" ? join(root, "blocked") : cwd;
    if (location === "unrelated") {
      const second = await catalog.create("Blocked project");
      await catalog.addRootBinding(second.projectId, blocked);
    }
    const realpath = fs.realpath;
    const native = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation((path) => {
      if (path.toString() === blocked)
        throw Object.assign(new Error("Filesystem unavailable"), { code });
      return native(path);
    });
    vi.spyOn(fs, "realpath").mockImplementation(async (path) => {
      if (path.toString() === blocked) {
        throw Object.assign(new Error("Filesystem unavailable"), { code });
      }
      return realpath(path);
    });
    const target =
      location === "ancestor"
        ? join(cwd, "missing")
        : location === "binding"
          ? nested
          : cwd;
    expect(await lookupRepository(target)).toMatchObject(
      location === "unrelated"
        ? { kind: "resolved", projectId: project.projectId }
        : { kind: "unavailable" },
    );
    if (location !== "unrelated") {
      await expect(
        catalog.resolveIdentityForPath(target),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
    }
  },
);

it("bounds repeated root probes and refreshes expired successes and failures", async () => {
  const alias = join(root, "alias");
  const { catalog, project } = await registered(alias);
  const cwd = join(root, "repo");
  const nested = join(cwd, "nested");
  await fs.mkdir(nested, { recursive: true });
  await fs.symlink(cwd, alias, "junction");
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const realpath = fs.realpath;
  const probe = vi.spyOn(fs, "realpath");
  const syncProbe = vi.spyOn(realpathSync, "native");
  for (let i = 0; i < 3; i++)
    expect((await catalog.resolveIdentityForPath(nested))?.projectId).toBe(
      project.projectId,
    );
  expect(probe.mock.calls.filter(([path]) => path === alias)).toHaveLength(1);
  expect(probe.mock.calls.filter(([path]) => path === nested)).toHaveLength(3);
  expect(syncProbe).not.toHaveBeenCalled();
  probe.mockImplementation(async (path) => {
    if (path === alias)
      throw Object.assign(new Error("Unreadable root"), { code: "EACCES" });
    return realpath(path);
  });
  clock.mockReturnValue(1_000);
  await expect(catalog.resolveIdentityForPath(nested)).rejects.toMatchObject({
    code: "storage_unavailable",
  });
  probe.mockImplementation(realpath);
  clock.mockReturnValue(2_000);
  expect((await catalog.resolveIdentityForPath(nested))?.projectId).toBe(
    project.projectId,
  );
});

it("rejects an invalid explicit selector instead of falling back to cwd", async () => {
  const { cwd } = await registered();
  expect(await lookupRepository(cwd, "")).toEqual({ kind: "unregistered" });
});

it("matches Studio expansion of a tilde-prefixed custom state root", async () => {
  const { project, cwd } = await registered();
  const tildeRoot = "~/" + relative(homedir(), stateRoot);
  expect(
    await resolveAgentMapProject({
      kind: "repository",
      stateRoot: tildeRoot,
      cwd,
    }),
  ).toMatchObject({
    kind: "resolved",
    projectId: project.projectId,
    stateRoot,
  });
});
