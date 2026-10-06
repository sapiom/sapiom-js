/**
 * The project map route: Studio draws exactly what `sapiom_dev_map` returns.
 *
 * `GET /api/projects/:projectId/map?ref=` scans the project's root in process
 * with `@sapiom/mcp/map` (`describeProject` + `buildMap`) and answers with the
 * map. Nothing is stored: the map is recomputed on every read, so a coding
 * agent calling the MCP tool and Studio always see the same agents and edges
 * (plans/agent-map-rebuild/design.md §1, §3).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { Router } from "express";
import { createClient } from "@sapiom/agent-core";
import {
  accountPlatform,
  buildMap,
  describeProject,
  MapInputError,
  type PlatformSource,
  type ScanOptions,
  accountEvaluate,
  fileLabelCache,
  labelMap,
  type Evaluate,
} from "@sapiom/mcp/map";

import type { ProjectMapResponse } from "../shared/project-map.js";

const execFileAsync = promisify(execFile);

export interface ProjectMapProject {
  projectId: string;
  displayName: string;
  /** Active root bindings that are also open workspace scopes. */
  roots: readonly string[];
}

export interface ProjectMapRouterOptions {
  resolveProject: (projectId: string) => Promise<ProjectMapProject | null>;
  /** null: signed out. Read per request so a sign-in takes effect without a restart. */
  platform: () => PlatformSource | null;
  /** Jev for the signed-in account, or null signed out: labels then read "unavailable". */
  evaluate?: () => Evaluate | null;
  /** Called with every root the route has drawn, so the server can watch it. */
  onRootRead?: (projectId: string, root: string) => void;
  /** Test seam; defaults to the real scan. */
  describe?: (options: ScanOptions) => ReturnType<typeof describeProject>;
}

/**
 * The platform source for the key the harness currently holds. The cache key
 * names the account the way `sapiom_dev_map` does, so repeated map reads (a
 * refresh, a file save) reuse its definitions and triggers for a short while.
 */
const keyIds = new Map<string, string>();

/** Jev through the key the harness currently holds. */
export function evaluateForKey(apiKey: string | null, host: string): Evaluate | null {
  return apiKey ? accountEvaluate(createClient({ host, apiKey })) : null;
}

export function platformForKey(apiKey: string | null, host: string): PlatformSource | null {
  if (!apiKey) return null;
  // A random id per key held in memory names the cache, so the key itself never enters it.
  const keyId = `${host}\0${apiKey}`;
  let cacheKey = keyIds.get(keyId);
  if (!cacheKey) {
    cacheKey = randomUUID();
    keyIds.set(keyId, cacheKey);
  }
  return accountPlatform(createClient({ host, apiKey }), { cacheKey });
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** The refs the header offers: the current branch and every local branch. Null outside a repo. */
export async function gitRefs(root: string): Promise<ProjectMapResponse["git"]> {
  if ((await git(root, ["rev-parse", "--is-inside-work-tree"])) !== "true") return null;
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const listed = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const branches = (listed ?? "").split("\n").filter(Boolean).sort();
  return { branch: branch || null, branches };
}

/**
 * The project's active root bindings that are open as workspace scopes. Folders are compared by
 * real path: macOS temp folders sit behind /var -> /private/var and Windows spells one folder
 * several ways, so the same folder can differ as text between the binding and the scope.
 */
export async function openProjectRoots(
  bindings: ReadonlyArray<{ status: string; localRootRef: string }>,
  scopes: ReadonlyArray<{ cwd: string }>,
): Promise<string[]> {
  const real = (folder: string) => realpath(folder).catch(() => path.resolve(folder));
  const open = await Promise.all(scopes.map((scope) => real(scope.cwd)));
  const roots: string[] = [];
  for (const binding of bindings) {
    if (binding.status !== "active") continue;
    const bound = await real(binding.localRootRef);
    if (open.some((cwd) => samePathText(cwd, bound))) roots.push(binding.localRootRef);
  }
  return roots;
}

/** Windows paths compare case-insensitively; elsewhere case matters. */
function samePathText(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

const REF_PATTERN = /^[A-Za-z0-9._/@~^-]{1,200}$/;

/** Mounted beneath the boot-token-protected `/api` boundary. */
export function createProjectMapRouter(options: ProjectMapRouterOptions): Router {
  const router = Router();
  const describe = options.describe ?? describeProject;
  // Concurrent reads of the same root and ref share one scan; nothing outlives it.
  const inFlight = new Map<string, Promise<ProjectMapResponse>>();

  const read = async (
    project: ProjectMapProject,
    root: string,
    ref: string | undefined,
    platform: PlatformSource | null,
  ) => {
    const [description, gitState] = await Promise.all([
      describe({ root, ...(ref ? { ref } : {}), platform }),
      gitRefs(root),
    ]);
    // Roles and edge labels, as sapiom_dev_map gives them: cached in the project's
    // .sapiom/cache, asked only for what changed, shown only at p >= 0.8.
    const evaluate = options.evaluate?.() ?? undefined;
    const { map } = await labelMap(buildMap(description), { evaluate, cache: fileLabelCache(root) });
    // The scan reports the real path; keep the folder the user opened so agent
    // paths match the workflow rows the rest of Studio holds.
    return {
      projectId: project.projectId,
      displayName: project.displayName,
      map: { ...map, root },
      git: gitState,
    } satisfies ProjectMapResponse;
  };

  router.get("/projects/:projectId/map", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const rawRef = typeof req.query.ref === "string" ? req.query.ref.trim() : "";
    if (rawRef && (!REF_PATTERN.test(rawRef) || rawRef.startsWith("-"))) {
      res.status(400).json({ code: "INVALID_REF", error: "Not a git ref" });
      return;
    }
    const ref = rawRef || undefined;
    let project: ProjectMapProject | null;
    try {
      project = await options.resolveProject(req.params.projectId);
    } catch {
      res.status(503).json({ code: "storage_unavailable", error: "The project catalog is unavailable" });
      return;
    }
    if (!project) {
      res.status(404).json({ code: "project_not_found", error: "Studio project not found" });
      return;
    }
    // A project with several folders draws its first; one folder is the common case.
    const root = project.roots[0];
    if (!root) {
      res.status(409).json({ code: "project_unavailable", error: "The project folder is not open" });
      return;
    }
    options.onRootRead?.(project.projectId, root);
    const platform = options.platform();
    // One scan per project, root, ref and sign-in state: the response carries
    // the project's identity and the account's deploy state.
    const key = JSON.stringify([project.projectId, root, ref ?? null, platform !== null]);
    let pending = inFlight.get(key);
    if (!pending) {
      pending = read(project, root, ref, platform).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    try {
      res.json(await pending);
    } catch (error) {
      // The folder was moved or deleted after the project was added.
      if (error instanceof MapInputError && error.code === "NOT_A_DIRECTORY") {
        res.status(409).json({ code: "project_unavailable", error: "The project folder no longer exists" });
        return;
      }
      if (error instanceof MapInputError) {
        res.status(400).json({ code: error.code, error: error.message });
        return;
      }
      // Two agent folders declare one name: the map cannot tell them apart.
      if (error instanceof Error && error.message.startsWith("Duplicate agent slug")) {
        res.status(400).json({ code: "DUPLICATE_SLUG", error: error.message });
        return;
      }
      res.status(500).json({ code: "map_failed", error: "The map could not be computed" });
    }
  });

  return router;
}
