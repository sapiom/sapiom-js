import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { importStudioComparisonProfile } from "./studio-comparison-profile.js";
import { StudioProjectCatalog } from "./studio-project-catalog.js";
import { StudioWorkspacePreferenceStore } from "./studio-workspace-preferences.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { AgentMapProposalService } from "./agent-map-proposal-service.js";
import { hasAuthoredAgentMap } from "./agent-map-initialization-record.js";
import {
  parseProjectPlanningAggregate,
  createEmptyProjectPlanningAggregate,
} from "./agent-map-aggregate-migration.js";
import { emptyProjectBuildPlanContent } from "../shared/build-plan.js";
import { BuildPlanStore } from "./build-plan-store.js";
import { BuildPlanService } from "./build-plan-service.js";
import { AgentBriefService } from "./agent-brief-service.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
const hash = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const readJson = async (file: string) =>
  JSON.parse(await fs.readFile(file, "utf8"));
async function write(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function hashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(root, file)] = entry.isFile()
      ? hash(await fs.readFile(file))
      : "directory";
  }
  return result;
}
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "studio-comparison-")),
  );
  temporary.push(root);
  const source = path.join(root, "desktop");
  const destination = path.join(root, "trial");
  const roots = ["mapped", "mapless", "unselected"].map((name) =>
    path.join(root, name),
  );
  const inventory = [
    ...roots.map((dir) => path.join(dir, "agent")),
    path.join(root, "sibling-agent"),
  ].map((agentPath, index) => ({
    path: agentPath,
    name: `Agent ${index}`,
    definitionId: null,
    definitionSlug: null,
    source: "scan",
  }));
  for (const agent of inventory) {
    await fs.mkdir(agent.path, { recursive: true });
    await fs.writeFile(
      path.join(agent.path, "index.ts"),
      'throw new Error("Never execute source");',
    );
  }
  const catalog = new StudioProjectCatalog(
    path.join(source, "studio-projects.json"),
  );
  const projects = (
    await catalog.reconcile(roots.map((cwd) => ({ cwd, workspaceKey: cwd })))
  ).projects;
  const ids = roots.map(
    (dir) =>
      projects.find(({ displayName }) => displayName === path.basename(dir))!
        .projectId,
  );
  const preferences = new StudioWorkspacePreferenceStore(
    path.join(source, "agent-map/studio-workspace-preferences.json"),
  );
  await preferences.registerCreatedAgent(
    ids[0]!,
    "source-creator",
    inventory[3]!,
  );
  for (const [index, projectId] of ids.entries())
    await preferences.current(
      "source-user",
      projectId,
      [roots[index]!],
      inventory,
      true,
    );
  await write(
    path.join(source, "workflows.json"),
    inventory.map((row) => ({ ...row, activeBuildRunId: "excluded-run" })),
  );
  await write(path.join(source, "settings.json"), {
    recentDirs: roots,
    projectRoot: root,
    telemetryOptIn: true,
  });
  for (const file of [
    "machine-id",
    "sessions.json",
    "pending-secrets.json",
    "credentials.json",
    "agent-map/project-bootstrap/job.json",
  ])
    await write(path.join(source, file), { excluded: true });
  const mapFile = (id = ids[0]!) =>
    path.join(source, "agent-map/projects", id, "workspace.json");
  const store = new AgentMapWorkspaceStore(path.join(source, "agent-map"));
  const service = new AgentMapProposalService(store);
  const actor = {
    projectId: ids[0]!,
    userId: "source-user",
    sessionId: "source-session",
  };
  const first = await service.propose(actor, {
    schemaVersion: 1,
    proposalId: null,
    expectedVersion: 0,
    requestId: "first",
    operations: [
      {
        kind: "add-node",
        draftRef: "research",
        node: {
          kind: "agent",
          name: "Research",
          purpose: "Research",
          ownerAgent: null,
          contractRefs: [],
        },
      },
    ],
  });
  const nodeId = Object.values(first.allocatedNodeIds)[0]!;
  await service.propose(actor, {
    schemaVersion: 1,
    proposalId: first.proposalId,
    expectedVersion: 1,
    requestId: "second",
    operations: [
      {
        kind: "update-node",
        nodeId,
        changes: { purpose: "Retain this history" },
      },
    ],
  });
  const journal = (id: string, status: string) =>
    write(path.join(path.dirname(mapFile(id)), "initialization.json"), {
      schemaVersion: 1,
      projectId: id,
      userId: "source-user",
      attemptId: randomUUID(),
      status,
      ownerId: status === "running" ? randomUUID() : null,
      ownerPid: status === "running" ? process.pid : null,
      provider: "claude-code",
      errorCode: status === "failed" ? "interrupted" : null,
      updatedAt: new Date().toISOString(),
    });
  const run = (projectIds = ids.slice(0, 2), target = destination) =>
    importStudioComparisonProfile({
      sourceStateRoot: source,
      destinationStateRoot: target,
      projectIds,
    });
  return {
    root,
    source,
    destination,
    roots,
    ids,
    inventory,
    store,
    service,
    actor,
    first,
    nodeId,
    mapFile,
    journal,
    run,
  };
}

it("preserves complete map bytes, plans, briefs, identities and cross-root agents while isolating bookkeeping", async () => {
  const f = await fixture();
  const aggregate = await f.store.readAggregate(f.ids[0]!);
  const expectedMap = {
    versionId: aggregate.current.map!.versionId,
    contentDigest: aggregate.current.map!.contentDigest,
  };
  const plans = new BuildPlanStore(f.store);
  const plan = await new BuildPlanService(plans).apply(f.actor, {
    schemaVersion: 1,
    requestId: "plan",
    expectedMap,
    expectedPlan: null,
    operations: [
      {
        op: "replace-content",
        content: {
          ...emptyProjectBuildPlanContent(),
          outcome: "Research",
          assignments: [
            {
              id: { clientRef: "assignment" },
              plannedAgentId: f.nodeId,
              briefId: null,
              mission: "Research",
              scope: ["Research"],
              nonGoals: [],
              dependencies: [],
            },
          ],
        },
      },
    ],
  });
  await new AgentBriefService(plans).refreshAfterPlanMutation(f.actor, {
    expectedMap,
    expectedPlan: {
      planId: plan.plan.planId,
      versionId: plan.plan.versionId,
      semanticDigest: plan.plan.semanticDigest,
    },
  });
  await f.journal(f.ids[0]!, "completed");
  await f.journal(f.ids[1]!, "failed");
  const before = await hashes(f.source);
  const sourceCode = await hashes(f.inventory[3]!.path);
  const result = await f.run();
  expect(result).toMatchObject({
    published: true,
    excluded: [],
    projects: [
      { projectId: f.ids[0], map: { authored: true } },
      { projectId: f.ids[1], map: null },
    ],
  });
  const targetMap = path.join(
    f.destination,
    path.relative(f.source, f.mapFile()),
  );
  const copied = await fs.readFile(targetMap);
  expect(copied).toEqual(await fs.readFile(f.mapFile()));
  expect(result.projects[0]!.map!.byteDigest).toBe(hash(copied));
  const parsed = parseProjectPlanningAggregate(
    JSON.parse(copied.toString()),
    f.ids[0]!,
  );
  expect(parsed.mapVersions).toHaveLength(2);
  expect(parsed.mapOperationHistory).toHaveLength(2);
  expect(parsed.buildPlanVersions).toHaveLength(1);
  expect(Object.keys(parsed.briefVersionsById)).not.toHaveLength(0);
  const catalog = await readJson(path.join(f.source, "studio-projects.json"));
  expect(
    await readJson(path.join(f.destination, "studio-projects.json")),
  ).toEqual({
    schemaVersion: catalog.schemaVersion,
    projects: catalog.projects.filter((project: { projectId: string }) =>
      f.ids.slice(0, 2).includes(project.projectId),
    ),
  });
  const prefsFile = "agent-map/studio-workspace-preferences.json";
  const sourcePrefs = await readJson(path.join(f.source, prefsFile));
  expect(await readJson(path.join(f.destination, prefsFile))).toEqual({
    schemaVersion: 1,
    preferences: [],
    agentBindings: sourcePrefs.agentBindings.filter(
      (binding: { projectId: string }) =>
        f.ids.slice(0, 2).includes(binding.projectId),
    ),
  });
  const copiedInventory = await readJson(
    path.join(f.destination, "workflows.json"),
  );
  expect(copiedInventory.map((row: { path: string }) => row.path)).toEqual([
    f.inventory[0]!.path,
    f.inventory[1]!.path,
    f.inventory[3]!.path,
  ]);
  expect(copiedInventory.some((row: object) => "activeBuildRunId" in row)).toBe(
    false,
  );
  expect(
    await readJson(path.join(f.destination, "settings.json")),
  ).toMatchObject({ recentDirs: f.roots.slice(0, 2), telemetryOptIn: false });
  expect(
    await readJson(path.join(f.destination, "comparison-profile.json")),
  ).toEqual(result);
  for (const forbidden of [
    "machine-id",
    "sessions.json",
    "pending-secrets.json",
    "credentials.json",
  ])
    expect(Object.keys(await hashes(f.destination))).not.toContain(forbidden);
  expect(
    Object.keys(await hashes(f.destination)).some((name) =>
      /initialization|bootstrap|\.lock/.test(name),
    ),
  ).toBe(false);
  expect(await hashes(f.source)).toEqual(before);
  expect(await hashes(f.inventory[3]!.path)).toEqual(sourceCode);
});

it("retains deliberately empty authored maps and un-authored empty containers distinctly", async () => {
  const f = await fixture();
  await f.service.propose(f.actor, {
    schemaVersion: 1,
    proposalId: f.first.proposalId,
    expectedVersion: 2,
    requestId: "remove",
    operations: [{ kind: "remove-node", nodeId: f.nodeId }],
  });
  await write(
    f.mapFile(f.ids[1]),
    createEmptyProjectPlanningAggregate(f.ids[1]!, new Date().toISOString()),
  );
  const result = await f.run();
  expect(result.projects.map(({ map }) => map?.authored)).toEqual([
    true,
    false,
  ]);
  const copied = await new AgentMapWorkspaceStore(
    path.join(f.destination, "agent-map"),
  ).readAggregate(f.ids[0]!);
  expect(copied.mapVersions.at(-1)!.graph.nodes).toEqual([]);
  expect(copied.mapVersions).toHaveLength(3);
  expect(hasAuthoredAgentMap(copied)).toBe(true);
});

it.each(["queued", "running"])(
  "defers %s source initialization and returns exclusions without an empty trial",
  async (status) => {
    const f = await fixture();
    await f.journal(f.ids[1]!, status);
    const before = await hashes(f.source);
    const absent = `project_${randomUUID()}`;
    expect(await f.run([f.ids[1]!, absent])).toMatchObject({
      published: false,
      projects: [],
      excluded: [
        { projectId: f.ids[1], reason: "initialization_busy" },
        { projectId: absent, reason: "project_not_found" },
      ],
    });
    await expect(fs.stat(f.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await f.run()).projects.map(({ projectId }) => projectId)).toEqual([
      f.ids[0],
    ]);
    expect(await hashes(f.source)).toEqual(before);
  },
);

it.each([
  "malformed",
  "digest",
  "future",
  "directory",
  "symlink",
  "unreadable",
  "journal",
])(
  "rejects %s map state without publishing or writing source",
  async (kind) => {
    const f = await fixture();
    const file =
      kind === "journal"
        ? path.join(path.dirname(f.mapFile()), "initialization.json")
        : f.mapFile();
    if (kind === "journal") await fs.writeFile(file, "null");
    if (kind === "malformed") await fs.writeFile(f.mapFile(), "{");
    if (kind === "digest") {
      const value = await readJson(f.mapFile());
      value.recordVersion++;
      await write(f.mapFile(), value);
    }
    if (kind === "future")
      await write(f.mapFile(), { storageSchemaVersion: 99 });
    if (kind === "directory" || kind === "symlink") {
      await fs.rm(f.mapFile());
      if (kind === "directory") await fs.mkdir(f.mapFile());
      else
        await fs.symlink(path.join(f.source, "credentials.json"), f.mapFile());
    }
    const before = await hashes(f.source);
    const actualRead = fs.readFile;
    const failure =
      kind === "unreadable"
        ? vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
            if (String(args[0]) === f.mapFile())
              throw Object.assign(new Error("permission denied"), {
                code: "EACCES",
              });
            return actualRead(...args);
          })
        : null;
    await expect(f.run()).rejects.toMatchObject({
      file: path.relative(f.source, file).split(path.sep).join("/"),
      code:
        kind === "future"
          ? "unsupported_schema"
          : kind === "directory" || kind === "unreadable"
            ? "source_unavailable"
            : kind === "symlink"
              ? "unsafe_source"
              : "invalid_state",
    });
    failure?.mockRestore();
    expect(await hashes(f.source)).toEqual(before);
    await expect(fs.stat(f.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("rejects a source mutation during staging and cleans the unpublished stage", async () => {
  const f = await fixture();
  const actualWrite = fs.writeFile;
  let changed = false;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await actualWrite(...args);
    if (!changed && String(args[0]).includes(".studio-comparison-")) {
      changed = true;
      await actualWrite(f.mapFile(), "{}");
    }
  });
  await expect(f.run()).rejects.toMatchObject({ code: "source_changed" });
  expect(
    (await fs.readdir(f.root)).filter((name) =>
      name.startsWith(".studio-comparison-"),
    ),
  ).toEqual([]);
  await expect(fs.stat(f.destination)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects a map removed between stat and read instead of importing it as mapless", async () => {
  const f = await fixture();
  const actualRead = fs.readFile;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    if (String(args[0]) === f.mapFile()) {
      await fs.rm(f.mapFile());
      throw Object.assign(new Error("removed during read"), { code: "ENOENT" });
    }
    return actualRead(...args);
  });
  await expect(f.run()).rejects.toMatchObject({ code: "source_changed" });
  await expect(fs.stat(f.destination)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects aliasing, overlapping, populated and symlinked destinations; accepts a fresh empty directory", async () => {
  const f = await fixture();
  const before = await hashes(f.source);
  await fs.symlink(f.source, path.join(f.root, "alias"));
  for (const target of [
    f.source,
    f.root,
    path.join(f.source, "nested"),
    path.join(f.root, "alias", "nested"),
  ])
    await expect(f.run(undefined, target)).rejects.toMatchObject({
      code: "unsafe_destination",
    });
  await fs.mkdir(f.destination);
  await write(path.join(f.destination, "keep.json"), { preserve: true });
  await expect(f.run()).rejects.toMatchObject({
    code: "destination_not_empty",
  });
  expect(await readJson(path.join(f.destination, "keep.json"))).toEqual({
    preserve: true,
  });
  await fs.rm(path.join(f.destination, "keep.json"));
  expect((await f.run()).published).toBe(true);
  expect(await hashes(f.source)).toEqual(before);
});

it("cleans staging after a write failure without replacing an existing empty destination", async () => {
  const f = await fixture();
  await fs.mkdir(f.destination);
  const before = await hashes(f.source);
  vi.spyOn(fs, "rename").mockRejectedValue(
    Object.assign(new Error("disk full"), { code: "ENOSPC" }),
  );
  await expect(f.run()).rejects.toMatchObject({
    code: "destination_unavailable",
  });
  expect(await fs.readdir(f.destination)).toEqual([]);
  expect(
    (await fs.readdir(f.root)).some((name) =>
      name.startsWith(".studio-comparison-"),
    ),
  ).toBe(false);
  expect(await hashes(f.source)).toEqual(before);
});

it("canonicalizes a harmless symlink ancestor while rejecting a symlink destination", async () => {
  const f = await fixture();
  const parent = path.join(f.root, "elsewhere");
  const alias = path.join(f.root, "alias");
  await fs.mkdir(parent);
  await fs.symlink(parent, alias);
  await expect(f.run(undefined, alias)).rejects.toMatchObject({
    code: "unsafe_destination",
  });
  const result = await f.run(undefined, path.join(alias, "new-trial"));
  expect(result.destinationStateRoot).toBe(path.join(parent, "new-trial"));
  expect(result.published).toBe(true);
});
