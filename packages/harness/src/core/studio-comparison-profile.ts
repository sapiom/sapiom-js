import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMapVersionRef } from "../shared/agent-map.js";
import type { HarnessSettings } from "../shared/types.js";
import { isWithinDir, samePath } from "../shared/paths.js";
import { sanitizeRecentDirs } from "../cli/settings.js";
import { expandHome } from "./paths.js";
import { parseProjectPlanningAggregate } from "./agent-map-aggregate-migration.js";
import {
  hasAuthoredAgentMap,
  initializationRecordSchema,
} from "./agent-map-initialization-record.js";
import {
  isStudioProjectId,
  parseStudioProjectCatalog,
  type ProjectRootBinding,
} from "./studio-project-catalog.js";
import { parseStudioWorkspacePreferences } from "./studio-workspace-preferences.js";

export interface StudioComparisonImportOptions {
  sourceStateRoot: string;
  destinationStateRoot: string;
  projectIds: readonly string[];
}

export interface StudioComparisonManifest {
  schemaVersion: 1;
  sourceStateRoot: string;
  destinationStateRoot: string;
  createdAt: string;
  published: boolean;
  projects: Array<{
    projectId: string;
    displayName: string;
    rootBindings: ProjectRootBinding[];
    map: null | {
      byteDigest: string;
      aggregateDigest: string;
      recordVersion: number;
      currentMap: AgentMapVersionRef | null;
      authored: boolean;
    };
  }>;
  excluded: Array<{
    projectId: string;
    reason: "initialization_busy" | "project_not_found";
  }>;
}

export class StudioComparisonImportError extends Error {
  constructor(
    readonly code:
      | "invalid_selection"
      | "invalid_state"
      | "unsupported_schema"
      | "source_unavailable"
      | "source_changed"
      | "unsafe_source"
      | "unsafe_destination"
      | "destination_not_empty"
      | "destination_unavailable",
    readonly file?: string,
  ) {
    super(`Studio comparison import: ${code}${file ? ` (${file})` : ""}`);
    this.name = "StudioComparisonImportError";
  }
}

const digest = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const fail = (
  code: StudioComparisonImportError["code"],
  file?: string,
): never => {
  throw new StudioComparisonImportError(code, file);
};

function validate<T>(file: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof StudioComparisonImportError) throw error;
    return fail(
      (error as { code?: string })?.code === "unsupported_schema"
        ? "unsupported_schema"
        : "invalid_state",
      file,
    );
  }
}

// No source store APIs: even a map-store read can create locks or migrate data.
class SourceSnapshot {
  readonly files = new Map<string, Buffer | null>();
  constructor(private readonly root: string) {}

  private async readFile(file: string): Promise<Buffer | null> {
    let present = false;
    try {
      let current = this.root;
      const parts = file.split("/");
      for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) return fail("unsafe_source", file);
        if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
          return fail("source_unavailable", file);
      }
      present = true;
      return await fs.readFile(current);
    } catch (error) {
      if (missing(error)) {
        if (present) fail("source_changed", file);
        return null;
      }
      if (error instanceof StudioComparisonImportError) throw error;
      return fail("source_unavailable", file);
    }
  }

  async read(file: string, required = false): Promise<Buffer | null> {
    const bytes = await this.readFile(file);
    if (required && bytes === null) return fail("source_unavailable", file);
    this.files.set(file, bytes);
    return bytes;
  }

  async json(file: string, fallback?: unknown): Promise<unknown> {
    const bytes = await this.read(file, fallback === undefined);
    return bytes === null
      ? fallback
      : validate(file, () => JSON.parse(bytes.toString("utf8")));
  }

  async verify(): Promise<void> {
    for (const [file, before] of this.files) {
      const after = await this.readFile(file);
      if (
        before === null
          ? after !== null
          : after === null || digest(before) !== digest(after)
      )
        fail("source_changed", file);
    }
  }
}

async function destinationPath(input: string, source: string): Promise<string> {
  const destination = expandHome(input);
  let ancestor = destination;
  const suffix: string[] = [];
  while (true) {
    try {
      const stat = await fs.lstat(ancestor);
      if (
        (ancestor === destination && stat.isSymbolicLink()) ||
        !(await fs.stat(ancestor)).isDirectory()
      )
        fail("unsafe_destination");
      break;
    } catch (error) {
      if (!missing(error)) throw error;
      if (path.dirname(ancestor) === ancestor) fail("unsafe_destination");
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const canonical = path.join(await fs.realpath(ancestor), ...suffix);
  if (isWithinDir(source, canonical) || isWithinDir(canonical, source))
    fail("unsafe_destination");
  return canonical;
}

async function requireEmpty(destination: string): Promise<void> {
  try {
    const stat = await fs.lstat(destination);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail("unsafe_destination");
    if ((await fs.readdir(destination)).length) fail("destination_not_empty");
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

/** Copies selected metadata into a new profile; trial jobs and identity are created at boot. */
async function importProfile(
  options: StudioComparisonImportOptions,
): Promise<StudioComparisonManifest> {
  const selected = [...new Set(options.projectIds)];
  if (!selected.length || selected.some((id) => !isStudioProjectId(id)))
    fail("invalid_selection");
  let source: string;
  try {
    source = await fs.realpath(expandHome(options.sourceStateRoot));
  } catch {
    return fail("source_unavailable");
  }
  const destination = await destinationPath(
    options.destinationStateRoot,
    source,
  );
  await requireEmpty(destination);
  const snapshot = new SourceSnapshot(source);
  const catalogFile = "studio-projects.json";
  const rawCatalog = await snapshot.json(catalogFile);
  const catalog = validate(catalogFile, () =>
    parseStudioProjectCatalog(rawCatalog),
  );
  const preferencesFile = "agent-map/studio-workspace-preferences.json";
  const rawPreferences = await snapshot.json(preferencesFile, {
    schemaVersion: 1,
    preferences: [],
    agentBindings: [],
  });
  const preferences = validate(preferencesFile, () =>
    parseStudioWorkspacePreferences(rawPreferences),
  );
  const workflows = await snapshot.json("workflows.json", []);
  if (
    !Array.isArray(workflows) ||
    workflows.some(
      (row) =>
        !record(row) ||
        typeof row.path !== "string" ||
        !path.isAbsolute(row.path) ||
        typeof row.name !== "string" ||
        !row.name ||
        (row.definitionId !== null && !Number.isSafeInteger(row.definitionId)),
    )
  )
    fail("invalid_state", "workflows.json");
  const settings = await snapshot.json("settings.json", { recentDirs: [] });
  if (
    !record(settings) ||
    (settings.recentDirs !== undefined &&
      (!Array.isArray(settings.recentDirs) ||
        settings.recentDirs.some((dir) => typeof dir !== "string")))
  )
    fail("invalid_state", "settings.json");
  const manifest: StudioComparisonManifest = {
    schemaVersion: 1,
    sourceStateRoot: source,
    destinationStateRoot: destination,
    createdAt: new Date().toISOString(),
    published: false,
    projects: [],
    excluded: [],
  };
  const maps = new Map<string, Buffer>();
  for (const projectId of selected) {
    const project = catalog.projects.find(
      (item) => item.projectId === projectId,
    );
    if (!project) {
      manifest.excluded.push({ projectId, reason: "project_not_found" });
      continue;
    }
    const directory = `agent-map/projects/${projectId}`;
    const journalFile = `${directory}/initialization.json`;
    const journalBytes = await snapshot.read(journalFile);
    if (journalBytes !== null) {
      const journal = validate(journalFile, () =>
        initializationRecordSchema.parse(
          JSON.parse(journalBytes.toString("utf8")),
        ),
      );
      if (journal.projectId !== projectId) fail("invalid_state", journalFile);
      if (journal.status === "running" || journal.status === "queued") {
        manifest.excluded.push({ projectId, reason: "initialization_busy" });
        continue;
      }
    }
    const file = `${directory}/workspace.json`;
    const bytes = await snapshot.read(file);
    let map: StudioComparisonManifest["projects"][number]["map"] = null;
    if (bytes !== null) {
      const aggregate = validate(file, () =>
        parseProjectPlanningAggregate(
          JSON.parse(bytes.toString("utf8")),
          projectId,
        ),
      );
      maps.set(file, bytes);
      map = {
        byteDigest: digest(bytes),
        aggregateDigest: aggregate.aggregateDigest,
        recordVersion: aggregate.recordVersion,
        currentMap: aggregate.current.map,
        authored: hasAuthoredAgentMap(aggregate),
      };
    }
    manifest.projects.push({
      projectId,
      displayName: project.displayName,
      rootBindings: project.rootBindings,
      map,
    });
  }
  await snapshot.verify();
  if (!manifest.projects.length) return manifest;
  const imported = new Set(manifest.projects.map(({ projectId }) => projectId));
  const roots = manifest.projects.flatMap(({ rootBindings }) =>
    rootBindings
      .filter(({ status }) => status === "active")
      .map(({ localRootRef }) => localRootRef),
  );
  const bindings = preferences.agentBindings.filter(({ projectId }) =>
    imported.has(projectId),
  );
  const inventory = (workflows as Array<Record<string, unknown>>)
    .filter((row) => {
      const agentPath = row.path as string;
      const owner = preferences.agentBindings.find(
        (binding) =>
          binding.createdBySessionId && samePath(binding.path, agentPath),
      );
      return owner
        ? imported.has(owner.projectId)
        : bindings.some((binding) => samePath(binding.path, agentPath)) ||
            roots.some((root) => isWithinDir(root, agentPath));
    })
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([key]) =>
          [
            "name",
            "path",
            "definitionId",
            "definitionSlug",
            "templateId",
            "forkId",
            "starterId",
            "source",
            "sourceDefinitionName",
            "markerPresent",
          ].includes(key),
        ),
      ),
    );
  const discoverySettings: HarnessSettings = {
    telemetryOptIn: false,
    productAnalyticsOptIn: false,
    rollingSummary: false,
    recentDirs: await sanitizeRecentDirs([
      ...((settings as { recentDirs?: string[] }).recentDirs ?? []).filter(
        (dir) => roots.some((root) => samePath(root, dir)),
      ),
      ...roots,
    ]),
  };
  const copiedCatalog = {
    schemaVersion: catalog.schemaVersion,
    projects: catalog.projects.filter(({ projectId }) =>
      imported.has(projectId),
    ),
  };
  const copiedPreferences = {
    schemaVersion: preferences.schemaVersion,
    preferences: [],
    agentBindings: bindings,
  };
  validate(catalogFile, () => parseStudioProjectCatalog(copiedCatalog));
  validate(preferencesFile, () =>
    parseStudioWorkspacePreferences(copiedPreferences),
  );
  const parent = path.dirname(destination);
  if (!samePath(await destinationPath(destination, source), destination))
    fail("unsafe_destination");
  await fs.mkdir(parent, { recursive: true });
  if (!samePath(await destinationPath(destination, source), destination))
    fail("unsafe_destination");
  const stage = await fs.mkdtemp(path.join(parent, ".studio-comparison-"));
  try {
    const write = async (file: string, bytes: Buffer | string) => {
      await fs.mkdir(path.dirname(path.join(stage, file)), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(path.join(stage, file), bytes, {
        mode: 0o600,
        flag: "wx",
      });
    };
    for (const [file, bytes] of maps) await write(file, bytes);
    for (const [file, value] of [
      [catalogFile, copiedCatalog],
      [preferencesFile, copiedPreferences],
      ["workflows.json", inventory],
      ["settings.json", discoverySettings],
    ] as const)
      await write(file, `${JSON.stringify(value, null, 2)}\n`);
    manifest.published = true;
    await write(
      "comparison-profile.json",
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    // A second verification brackets staging as well as the initial collection.
    await snapshot.verify();
    if (!samePath(await destinationPath(destination, source), destination))
      fail("unsafe_destination");
    await requireEmpty(destination);
    await fs.rename(stage, destination);
    return manifest;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function importStudioComparisonProfile(
  options: StudioComparisonImportOptions,
): Promise<StudioComparisonManifest> {
  try {
    return await importProfile(options);
  } catch (error) {
    if (error instanceof StudioComparisonImportError) throw error;
    return fail("destination_unavailable");
  }
}
