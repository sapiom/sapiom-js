import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyLegacyContainer } from "./test-fixtures/empty-legacy-container.js";
import { createEmptyProjectPlanningAggregate } from "./agent-map-aggregate-migration.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { DurableFileLock } from "./durable-file-lock.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(value: unknown = emptyLegacyContainer(projectId)) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "empty-legacy-map-"));
  roots.push(root);
  const directory = path.join(root, "projects", projectId);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "workspace.json");
  // Retain whitespace as well as the data in the original backup.
  const original = Buffer.from(`${JSON.stringify(value, null, 3)}\n\n`);
  await fs.writeFile(file, original);
  const backups = async () =>
    (await fs.readdir(directory)).filter((name) =>
      name.endsWith(".backup.json"),
    );
  return {
    root,
    directory,
    file,
    original,
    backups,
    store: new AgentMapWorkspaceStore(root),
  };
}

describe("unused wrapped-format-2 compatibility", () => {
  it.each([9, 10, 13, 14] as const)(
    "converts a late read of the exact %i-field historical container",
    async (variant) => {
      const legacy = emptyLegacyContainer(projectId, variant);
      const f = await fixture(legacy);
      const result = await f.store.readAggregate(projectId);
      expect(result).toEqual(
        createEmptyProjectPlanningAggregate(
          projectId,
          legacy.workspace.createdAt,
        ),
      );
      const backups = await f.backups();
      expect(backups).toHaveLength(1);
      expect(await fs.readFile(path.join(f.directory, backups[0]!))).toEqual(
        f.original,
      );
      expect(
        (await fs.stat(path.join(f.directory, backups[0]!))).mode & 0o777,
      ).toBe(0o600);
      const converted = await fs.readFile(f.file);
      await new AgentMapWorkspaceStore(f.root).readAggregate(projectId);
      expect(await fs.readFile(f.file)).toEqual(converted);
      expect(await f.backups()).toEqual(backups);
    },
  );

  it("converts during startup and eligibility inspection without scheduling or claiming initialization", async () => {
    const f = await fixture();
    await f.store.migrateEmptyLegacyContainers();
    const converted = await fs.readFile(f.file);
    await f.store.inspectInitialization(
      projectId,
      async (aggregate, journal) => {
        expect(aggregate.current.map).toBeNull();
        expect(await journal.read()).toBeNull();
      },
    );
    await f.store.migrateEmptyLegacyContainers();
    expect(await fs.readFile(f.file)).toEqual(converted);
    expect(await fs.readdir(f.directory)).toHaveLength(2);
  });

  it("repairs a late record before no-write eligibility inspection", async () => {
    const f = await fixture();
    await f.store.inspectInitialization(
      projectId,
      async (aggregate, journal) => {
        expect(aggregate.mapVersions).toEqual([]);
        expect(await journal.read()).toBeNull();
      },
    );
    expect(JSON.parse(await fs.readFile(f.file, "utf8"))).toHaveProperty(
      "current",
    );
    expect(await f.backups()).toHaveLength(1);
  });

  const refusals: [string, unknown][] = [
    ["storageSchemaVersion", 1],
    ["storageSchemaVersion", 99],
    ["extra", {}],
    ["workspace.extra", null],
    ["workspace.projectId", "project_00000000-0000-4000-8000-000000000002"],
    ["workspace.schemaVersion", 2],
    ["workspace.recordVersion", 2],
    ["workspace.recordVersion", 0],
    ["workspace.updatedAt", "2026-09-02T12:00:00.000Z"],
    ["workspace.createdAt", "invalid"],
    ["workspace.confirmedRevisionId", "cleared-map"],
    ["workspace.activeProposalId", "proposal"],
    ["workspace.projectBuildPlanId", "plan"],
    ["proposal", { nodes: [], relationships: [], history: [] }],
    ["receipts", [{}]],
    ["receipts", {}],
    ["buildPlanning.schemaVersion", 2],
    ["buildPlanning.planId", "plan"],
    ["buildPlanning.currentPlanVersion", 1],
    ["buildPlanning.planVersions", [{}]],
    ["buildPlanning.currentBriefByAgentId", { agent: null }],
    ["buildPlanning.briefVersionsById", { brief: [] }],
    ["buildPlanning.assignmentByAgentId", { agent: {} }],
    ["buildPlanning.submissionsByAssignmentId", { assignment: [] }],
    ["buildPlanning.idempotencyReceipts", [{}]],
    ["buildPlanning.idempotencyTombstones", [{}]],
    ["buildPlanning.fanoutApprovals", [{}]],
    ["buildPlanning.builderBindingsByAssignmentId", { assignment: {} }],
    ["buildPlanning.planningSubmissionReceipts", [{}]],
    ["buildPlanning.fanoutConsents", [{}]],
    ["buildPlanning.extra", []],
  ];
  it.each(refusals)(
    "preserves uncertain or authored input: %s = %j",
    async (key, replacement) => {
      const value = emptyLegacyContainer(projectId, 14);
      const parts = key.split(".");
      const object =
        parts.length === 1
          ? value
          : value[parts[0] as "workspace" | "buildPlanning"];
      (object as Record<string, unknown>)[parts.at(-1)!] = replacement;
      const f = await fixture(value);
      await f.store.migrateEmptyLegacyContainers();
      expect(await fs.readFile(f.file)).toEqual(f.original);
      expect(await f.backups()).toEqual([]);
      if (key !== "storageSchemaVersion" || replacement !== 1) {
        await expect(
          f.store.inspectInitialization(projectId, async () => true),
        ).rejects.toHaveProperty("code");
        expect(await fs.readFile(f.file)).toEqual(f.original);
      }
    },
  );

  it("rejects incomplete combinations of historical optional fields", async () => {
    const value = emptyLegacyContainer(projectId);
    delete value.buildPlanning.planningSubmissionReceipts;
    const f = await fixture(value);
    await f.store.migrateEmptyLegacyContainers();
    expect(await fs.readFile(f.file)).toEqual(f.original);
    await expect(f.store.readAggregate(projectId)).rejects.toMatchObject({
      code: "malformed_state",
    });
  });

  it("keeps current format 2 and malformed JSON byte-for-byte unchanged", async () => {
    const f = await fixture(
      createEmptyProjectPlanningAggregate(
        projectId,
        "2026-09-01T12:00:00.000Z",
      ),
    );
    await f.store.migrateEmptyLegacyContainers();
    expect(await fs.readFile(f.file)).toEqual(f.original);
    expect(await f.backups()).toEqual([]);
    await fs.writeFile(f.file, "{broken");
    await f.store.migrateEmptyLegacyContainers();
    await expect(
      f.store.inspectInitialization(projectId, async () => true),
    ).rejects.toMatchObject({ code: "malformed_state" });
    expect(await fs.readFile(f.file, "utf8")).toBe("{broken");
  });

  it("rechecks the record after waiting for the project lock", async () => {
    const f = await fixture();
    const release = await new DurableFileLock(f.file).acquire();
    const migration = f.store.migrateEmptyLegacyContainers();
    const current = JSON.stringify(
      createEmptyProjectPlanningAggregate(
        projectId,
        "2026-09-01T12:00:00.000Z",
      ),
    );
    await fs.writeFile(f.file, current);
    await release();
    await migration;
    expect(await fs.readFile(f.file, "utf8")).toBe(current);
    expect(await f.backups()).toEqual([]);
  });

  it("publishes one backup and conversion across independent stores", async () => {
    const f = await fixture();
    const onEvent = vi.fn();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        new AgentMapWorkspaceStore(f.root, {
          onEvent,
        }).migrateEmptyLegacyContainers(),
      ),
    );
    expect(await f.backups()).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({
      name: "agent_map.empty_legacy_container_migrated",
      projectId,
    });
  });

  it.each(["write", "file-sync", "rename", "directory-sync"] as const)(
    "recovers an interrupted %s with its original backup intact",
    async (step) => {
      const f = await fixture();
      const store = new AgentMapWorkspaceStore(f.root, {
        beforePersistStep: (at) => {
          if (at === step) throw new Error("interrupted");
        },
      });
      await expect(store.readAggregate(projectId)).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      const onDisk = JSON.parse(await fs.readFile(f.file, "utf8"));
      expect(onDisk).toEqual(
        step === "directory-sync"
          ? createEmptyProjectPlanningAggregate(
              projectId,
              emptyLegacyContainer(projectId).workspace.createdAt,
            )
          : emptyLegacyContainer(projectId),
      );
      await f.store.readAggregate(projectId);
      const backups = await f.backups();
      expect(backups).toHaveLength(1);
      expect(await fs.readFile(path.join(f.directory, backups[0]!))).toEqual(
        f.original,
      );
    },
  );

  it("does not replace the workspace if its backup cannot be verified", async () => {
    const f = await fixture();
    const digest = createHash("sha256").update(f.original).digest("hex");
    await fs.writeFile(
      path.join(
        f.directory,
        `workspace.empty-wrapped-v2.${digest}.backup.json`,
      ),
      "corrupt backup",
    );
    await expect(f.store.readAggregate(projectId)).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    expect(await fs.readFile(f.file)).toEqual(f.original);
  });
});
