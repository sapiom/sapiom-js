import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  StudioProjectId,
  StudioProjectSummary,
} from "../shared/agent-map.js";
import { isStudioProjectId } from "./studio-project-catalog.js";

interface PersistedProjectBootstrapOutboxEntry {
  schemaVersion: 1;
  projectId: StudioProjectId;
  projectCreatedAt: string;
}

const OUTBOX_TEMP_FILE_RE =
  /^(project_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json\.tmp-[1-9][0-9]*-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export interface ProjectBootstrapOutboxEntry {
  projectId: StudioProjectId;
  projectCreatedAt: string;
}

export class ProjectBootstrapOutboxError extends Error {
  readonly code = "project_bootstrap_outbox_unavailable";

  constructor() {
    super("project bootstrap outbox is unavailable");
    this.name = "ProjectBootstrapOutboxError";
  }
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseEntry(
  value: unknown,
  expectedProjectId: StudioProjectId,
): ProjectBootstrapOutboxEntry | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "projectCreatedAt,projectId,schemaVersion" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("projectId" in value) ||
    value.projectId !== expectedProjectId ||
    !("projectCreatedAt" in value) ||
    !isTimestamp(value.projectCreatedAt)
  ) {
    return null;
  }
  return {
    projectId: expectedProjectId,
    projectCreatedAt: value.projectCreatedAt,
  };
}

/**
 * Write-ahead marker for the catalog -> bootstrap-intent boundary.
 *
 * A marker is committed before a new Studio project enters the catalog. The
 * marker is removed only after ProjectBootstrapCoordinator has durably
 * scheduled that project. Therefore either side of a process crash is safe:
 * an orphan marker has no catalog project and can be discarded, while a
 * committed project with a marker is recovered without guessing that older
 * catalog projects should be enrolled.
 */
export class ProjectBootstrapOutbox {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private file(projectId: StudioProjectId): string {
    if (!isStudioProjectId(projectId)) throw new ProjectBootstrapOutboxError();
    const file = path.resolve(this.root, `${projectId}.json`);
    if (!file.startsWith(`${this.root}${path.sep}`)) {
      throw new ProjectBootstrapOutboxError();
    }
    return file;
  }

  async stage(
    projects: readonly Pick<StudioProjectSummary, "projectId" | "createdAt">[],
  ): Promise<void> {
    try {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      for (const project of projects) {
        const file = this.file(project.projectId);
        try {
          const existing = parseEntry(
            JSON.parse(await fs.readFile(file, "utf8")) as unknown,
            project.projectId,
          );
          if (!existing || existing.projectCreatedAt !== project.createdAt) {
            throw new ProjectBootstrapOutboxError();
          }
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const entry: PersistedProjectBootstrapOutboxEntry = {
          schemaVersion: 1,
          projectId: project.projectId,
          projectCreatedAt: project.createdAt,
        };
        const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
        try {
          await fs.writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          await fs.rename(temporary, file);
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => {});
        }
      }
    } catch (error) {
      if (error instanceof ProjectBootstrapOutboxError) throw error;
      throw new ProjectBootstrapOutboxError();
    }
  }

  async pending(): Promise<ProjectBootstrapOutboxEntry[]> {
    try {
      const names = await fs.readdir(this.root);
      const entries: ProjectBootstrapOutboxEntry[] = [];
      for (const name of names.sort()) {
        const temporary = OUTBOX_TEMP_FILE_RE.exec(name);
        if (temporary && isStudioProjectId(temporary[1])) {
          // A process may die after writing a private temporary marker but
          // before its atomic rename. The corresponding catalog transaction
          // cannot have committed yet. Ignore this exact writer-owned shape;
          // deleting it could race another process that still owns the active
          // catalog transaction.
          continue;
        }
        // Desktop metadata and unrelated files do not describe project work.
        // Only the reserved committed-marker namespace can block recovery.
        if (!name.startsWith("project_") || !name.endsWith(".json")) continue;
        const match = /^(project_[0-9a-f-]+)\.json$/.exec(name);
        if (!match || !isStudioProjectId(match[1])) {
          throw new ProjectBootstrapOutboxError();
        }
        const projectId = match[1];
        const entry = parseEntry(
          JSON.parse(
            await fs.readFile(this.file(projectId), "utf8"),
          ) as unknown,
          projectId,
        );
        if (!entry) throw new ProjectBootstrapOutboxError();
        entries.push(entry);
      }
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof ProjectBootstrapOutboxError) throw error;
      throw new ProjectBootstrapOutboxError();
    }
  }

  async complete(projectId: StudioProjectId): Promise<void> {
    try {
      await fs.rm(this.file(projectId), { force: true });
    } catch (error) {
      if (error instanceof ProjectBootstrapOutboxError) throw error;
      throw new ProjectBootstrapOutboxError();
    }
  }
}
