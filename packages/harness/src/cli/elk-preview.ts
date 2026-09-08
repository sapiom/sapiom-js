import * as fs from "node:fs/promises";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { createServer } from "node:net";
import { z } from "zod";
import { expandHome, resolveStatePaths } from "../core/paths.js";
import { importStudioComparisonProfile } from "../core/studio-comparison-profile.js";
import {
  isStudioProjectId,
  parseStudioProjectCatalog,
} from "../core/studio-project-catalog.js";
import { isWithinDir, samePath } from "../shared/paths.js";
import { runCli } from "./bin.js";
import { loadSettings } from "./settings.js";

export function parseComparisonArgs(argv: string[]) {
  let sourceStateRoot: string | undefined;
  let destinationStateRoot = "";
  const projectIds: string[] = [];
  let port = 4101;
  let noOpen = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--no-open") {
      noOpen = true;
      continue;
    }
    if (
      !["--source-state-root", "--state-root", "--project", "--port"].includes(
        flag!,
      )
    )
      throw new Error(`Unknown comparison argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${flag} requires a value`);
    if (flag === "--source-state-root") sourceStateRoot = expandHome(value);
    if (flag === "--state-root") destinationStateRoot = expandHome(value);
    if (flag === "--project") {
      if (!isStudioProjectId(value))
        throw new Error(`Invalid project ID: ${value}`);
      projectIds.push(value);
    }
    if (flag === "--port") {
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("--port must be an integer from 0 to 65535");
    }
  }
  if (!destinationStateRoot)
    throw new Error(
      "--state-root is required for an isolated comparison profile",
    );
  return {
    sourceStateRoot,
    destinationStateRoot,
    projectIds: [...new Set(projectIds)],
    port,
    noOpen,
  };
}

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  published: z.literal(true),
  createdAt: z.string().datetime(),
  sourceStateRoot: z.string(),
  destinationStateRoot: z.string(),
  projects: z
    .array(
      z.object({
        projectId: z.string().refine(isStudioProjectId),
        displayName: z.string(),
      }),
    )
    .nonempty(),
  excluded: z.array(
    z.object({
      projectId: z.string().refine(isStudioProjectId),
      reason: z.enum(["initialization_busy", "project_not_found"]),
    }),
  ),
});

/** Reopening must never silently reimport, even when state is missing or damaged. */
export async function prepareComparisonProfile(
  options: ReturnType<typeof parseComparisonArgs>,
) {
  const destination = options.destinationStateRoot;
  const stat = await fs
    .lstat(destination)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (
    stat === null ||
    (stat.isDirectory() && (await fs.readdir(destination)).length === 0)
  ) {
    if (!options.sourceStateRoot || options.projectIds.length === 0)
      throw new Error(
        "First import requires --source-state-root and at least one --project. Reopen requires an existing comparison-profile.json.",
      );
    const manifest = await importStudioComparisonProfile({
      ...options,
      sourceStateRoot: options.sourceStateRoot,
    });
    for (const excluded of manifest.excluded)
      console.log(`Excluded ${excluded.projectId}: ${excluded.reason}`);
    if (!manifest.published)
      throw new Error(
        "No projects imported; comparison server was not started.",
      );
  }
  if (!(await fs.lstat(destination)).isDirectory())
    throw new Error("Comparison destination must be a directory.");
  const canonical = await fs.realpath(destination);
  // Cover writable runtime metadata, including local events with telemetry off.
  // Do not walk the root or catalog's shared agent source directories.
  for (const file of [
    path.join(canonical, "comparison-profile.json"),
    path.join(canonical, "comparison-profile.lock"),
    ...Object.values(resolveStatePaths(canonical)).filter(
      (file) => file !== canonical,
    ),
  ]) {
    const entry = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (entry?.isSymbolicLink())
      throw new Error(
        `Comparison state contains a symlink: ${path.relative(canonical, file)}`,
      );
    if (entry?.isDirectory())
      for (const child of await fs.readdir(file, {
        recursive: true,
        withFileTypes: true,
      }))
        if (child.isSymbolicLink())
          throw new Error(
            `Comparison state contains a symlink: ${path.relative(canonical, path.join(child.parentPath, child.name))}`,
          );
  }
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(
      JSON.parse(
        await fs.readFile(
          path.join(canonical, "comparison-profile.json"),
          "utf8",
        ),
      ),
    );
  } catch {
    throw new Error(
      "Invalid comparison-profile.json; use the original comparison directory or a distinct new destination for a fresh snapshot.",
    );
  }
  if (
    !path.isAbsolute(manifest.sourceStateRoot) ||
    !samePath(manifest.destinationStateRoot, canonical) ||
    isWithinDir(manifest.sourceStateRoot, canonical) ||
    isWithinDir(canonical, manifest.sourceStateRoot)
  )
    throw new Error(
      "Comparison manifest paths do not match an isolated destination.",
    );
  if (
    options.sourceStateRoot &&
    !samePath(
      await fs.realpath(options.sourceStateRoot),
      manifest.sourceStateRoot,
    )
  )
    throw new Error(
      "Source differs from the saved snapshot; use a new destination.",
    );
  const imported = manifest.projects.map((project) => project.projectId);
  const selected = [
    ...imported,
    ...manifest.excluded.map((entry) => entry.projectId),
  ];
  if (
    options.projectIds.length &&
    ![imported, selected].some(
      (ids) =>
        JSON.stringify([...options.projectIds].sort()) ===
        JSON.stringify([...ids].sort()),
    )
  )
    throw new Error(
      "Projects differ from the saved snapshot; omit --project to reopen it, or use a new destination.",
    );
  const catalog = parseStudioProjectCatalog(
    JSON.parse(
      await fs.readFile(path.join(canonical, "studio-projects.json"), "utf8"),
    ),
  );
  if (
    manifest.projects.some(
      (project) =>
        !catalog.projects.some(
          (entry) => entry.projectId === project.projectId,
        ),
    )
  )
    throw new Error(
      "Comparison profile is missing an imported project registration.",
    );
  const roots = catalog.projects
    .filter((project) => imported.includes(project.projectId))
    .flatMap((project) => project.rootBindings)
    .filter((binding) => binding.status === "active")
    .map((binding) => binding.localRootRef);
  const settings = await loadSettings(path.join(canonical, "settings.json"));
  // Keep the imported recent-dir order: a new entry would evict the eighth root.
  const candidates = [
    ...settings.recentDirs.filter((dir) =>
      roots.some((root) => samePath(root, dir)),
    ),
    ...roots,
  ];
  for (const launchDir of new Set(candidates)) {
    const resolved = await fs.realpath(launchDir).catch(() => null);
    if (
      resolved &&
      !isWithinDir(canonical, resolved) &&
      (await fs.stat(resolved).catch(() => null))?.isDirectory()
    )
      return { ...manifest, launchDir };
  }
  throw new Error(
    "Reconnect an imported project directory before launching this comparison; none of its active roots is available.",
  );
}

export async function requireAvailablePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(
        new Error(
          `Cannot bind localhost:${port}; choose another --port. No existing server was stopped.`,
        ),
      ),
    );
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

export async function launchComparison(argv: string[]): Promise<void> {
  const options = parseComparisonArgs(argv);
  await requireAvailablePort(options.port);
  const manifest = await prepareComparisonProfile(options);
  const lockPath = path.join(
    manifest.destinationStateRoot,
    "comparison-profile.lock",
  );
  const lock = await fs
    .open(lockPath, "wx", 0o600)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        throw new Error(
          `Comparison profile is already claimed (${lockPath}). Stop its trial process first; after an interrupted shutdown, remove the stale lock only after confirming that process has exited.`,
        );
      throw error;
    });
  const release = () => rmSync(lockPath, { force: true });
  try {
    await lock.writeFile(String(process.pid));
    await lock.close();
    process.once("exit", release);
    console.log(
      `Snapshot: ${manifest.createdAt}\nSource: ${manifest.sourceStateRoot}\nComparison: ${manifest.destinationStateRoot}`,
    );
    for (const project of manifest.projects)
      console.log(`Project: ${project.projectId} (${project.displayName})`);
    await runCli([
      manifest.launchDir,
      "--state-root",
      manifest.destinationStateRoot,
      "--port",
      String(options.port),
      "--no-session",
      "--no-telemetry",
      "--map-layout",
      "elk",
      ...(options.noOpen ? ["--no-open"] : []),
    ]);
  } catch (error) {
    await lock.close().catch(() => {});
    process.removeListener("exit", release);
    release();
    throw error;
  }
}
