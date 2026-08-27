/**
 * `.sapiom/studio-rail.json` — the Group axis's stored arrangement, one file
 * per project root (SAP-2929; design.md § Persistence).
 *
 * This router is deliberately DUMB about the file's meaning. It reads, writes
 * and removes an opaque UTF-8 blob; every rule about what the blob means —
 * defensive parsing, pruning member paths no agent claims, and above all the
 * difference between `groups: null` ("nothing stored, detection owns this") and
 * `groups: []` ("the user materialized groups and then deleted them all") —
 * lives in ONE place, `web/src/lib/agent-groups.ts`, where it is unit-tested.
 *
 * That split is the point. In the reference prototype the null/empty
 * distinction was collapsed by a second, well-meaning serializer on the write
 * path: the first page load wrote `groups: []` for a state that was `null`, and
 * from the second load onward every agent fell into `Ungrouped`, in every
 * project, permanently. A server that re-encodes the shape is a second place
 * for that to happen. So the wire format here is `{ raw }` — the exact text —
 * and "un-materialized" reaches disk as DELETE, never as a write.
 *
 * Containment: `root` must be a project root the studio actually knows about
 * (`listKnownRoots`, injected — recentDirs, the configured project root, and
 * live session cwds, which is exactly the set `web/src/lib/project-tree.ts`
 * turns into project rows). Resolution happens before any disk access, so this
 * route cannot be turned into an arbitrary-path file reader or writer. The
 * written path is confined under `<root>/.sapiom/` by `resolveWithinRoot`, so a
 * symlinked `.sapiom` cannot land the file outside the project.
 *
 * Mounted under the same `/api` boot-token middleware as the rest of the REST
 * surface (server/index.ts).
 */
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Router, type Router as ExpressRouter } from "express";

import type { StudioRailFileResponse, StudioRailLaunchEdgesResponse } from "../shared/types.js";
import { detectWorkflowLaunches } from "../core/canvas-interconnections.js";
import { hasTraversalSegment, resolveWithinRoot } from "../core/path-safety.js";

/** The directory the file lives in: already a live convention (canvas renders,
 *  harness-context.json) and already skipped by every source scan. */
const SAPIOM_DIR = ".sapiom";
export const STUDIO_RAIL_FILE = "studio-rail.json";

/**
 * A stored arrangement is a handful of ids, labels and absolute paths. The cap
 * is a backstop against a client (or a hand edit) turning a preferences file
 * into a place to park a megabyte, not a real limit on how many groups a
 * project may have.
 */
export const MAX_STUDIO_RAIL_BYTES = 256 * 1024;

export interface StudioRailDeps {
  /**
   * Every project root the studio knows about — recentDirs, the configured
   * project root, and the cwd of every live session. The client's project rows
   * come from the same three sources, so a root that can be shown is a root
   * that can be written to, and nothing else is.
   */
  listKnownRoots: () => string[] | Promise<string[]>;
  /**
   * The registered agents. Launch edges are computed from these and only these:
   * an agent this install lacks is not a node, so an edge pointing at it is
   * simply not an edge that can be drawn.
   */
  listWorkflows: () => Array<{ name: string; path: string }>;
}

/** Trailing separators are spelling, not identity — `<root>/` and `<root>`
 *  are one directory, and the client stores whichever the user typed. */
const canonical = (p: string): string => {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

/**
 * The absolute, resolved root when `candidate` is a project root the studio
 * knows about — null otherwise, which every route answers as a 400 rather than
 * reaching for the disk.
 */
function resolveKnownRoot(candidate: unknown, knownRoots: readonly string[]): string | null {
  if (typeof candidate !== "string" || candidate.trim() === "") return null;
  if (hasTraversalSegment(candidate)) return null;
  if (!path.isAbsolute(candidate)) return null;
  const wanted = canonical(candidate);
  return knownRoots.some((root) => canonical(root) === wanted) ? path.resolve(candidate) : null;
}

/** `<root>/.sapiom/studio-rail.json`, or null if that escapes `root`. */
export function studioRailPath(root: string): string | null {
  return resolveWithinRoot(root, path.join(SAPIOM_DIR, STUDIO_RAIL_FILE));
}

/**
 * The stored blob, or null.
 *
 * An absent file, an unreadable directory and an oversized file all read as
 * null — "nothing stored", which the model turns into the derived groups. A
 * rail that throws on a bad preferences file is a rail you cannot open in order
 * to fix it.
 */
export async function readStudioRailFile(root: string): Promise<string | null> {
  const file = studioRailPath(root);
  if (file == null) return null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_STUDIO_RAIL_BYTES) return null;
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Writes the blob verbatim, creating `.sapiom/` if it is not there yet. */
export async function writeStudioRailFile(root: string, raw: string): Promise<void> {
  const file = studioRailPath(root);
  if (file == null) throw new Error("studio-rail path escapes the project root");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, raw, "utf8");
}

/**
 * Removes the file. Missing is success: "there is no stored arrangement" is the
 * requested end state, and DELETE is how an un-materialized state — including
 * the one `Reset to detected` produces — reaches disk. Skipping the write
 * instead would let the old arrangement outlive the reset.
 */
export async function removeStudioRailFile(root: string): Promise<void> {
  const file = studioRailPath(root);
  if (file == null) return;
  try {
    await fs.rm(file);
  } catch {
    // ENOENT and a read-only checkout alike: nothing stored is the goal state.
  }
}

/**
 * Launch edges across every registered agent, as parent-name to child-slug.
 *
 * Uses the EXISTING grep (`core/canvas-interconnections.ts`) — the same
 * detector the canvas draws its dashed launched-workflow nodes from. A second
 * edge detector would be a second answer to "what does this launch", and the
 * axis and the system map are supposed to be reading one graph.
 *
 * `knownStepIds` is empty on purpose: that argument exists so a capability chip
 * can be attributed to the step it sits in, and a group does not care which
 * step launched the child, only that the launch exists.
 *
 * `child` is the `definition` slug as written at the call site. Matching it to
 * an agent is the client's job (a slug can name an agent by `definitionSlug` or
 * by folder name), and an unmatched slug is simply not an edge.
 */
export async function detectLaunchEdges(
  workflows: ReadonlyArray<{ name: string; path: string }>,
): Promise<StudioRailLaunchEdgesResponse["edges"]> {
  const edges: StudioRailLaunchEdgesResponse["edges"] = [];
  const seen = new Set<string>();
  for (const workflow of workflows) {
    let launches: Awaited<ReturnType<typeof detectWorkflowLaunches>>;
    try {
      launches = await detectWorkflowLaunches(workflow.path, new Set());
    } catch {
      continue;
    }
    for (const launch of launches) {
      // A project that launches the same definition from three steps is ONE
      // edge: the group is about the relationship, not its multiplicity.
      const key = JSON.stringify([workflow.name, launch.slug]);
      if (launch.slug === workflow.name || seen.has(key)) continue;
      seen.add(key);
      edges.push({ parent: workflow.name, child: launch.slug });
    }
  }
  return edges;
}

/**
 * GET    /api/studio-rail?root=abs   -> { root, raw: string | null }
 * PUT    /api/studio-rail?root=abs   { raw } -> { ok: true }
 * DELETE /api/studio-rail?root=abs   -> { ok: true }
 * GET    /api/studio-rail/launch-edges -> { edges: [{ parent, child }] }
 */
export function createStudioRailRouter(deps: StudioRailDeps): ExpressRouter {
  const router = Router();

  // BEFORE the `?root=` routes: `/api/studio-rail/launch-edges` carries no
  // root, and a root-less request must never be answered with a file read.
  router.get("/api/studio-rail/launch-edges", async (_req, res, next) => {
    try {
      const edges = await detectLaunchEdges(deps.listWorkflows());
      res.json({ edges } satisfies StudioRailLaunchEdgesResponse);
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/studio-rail", async (req, res, next) => {
    const root = resolveKnownRoot(req.query.root, await deps.listKnownRoots());
    if (root == null) {
      res.status(400).json({ error: "root must be a known project root" });
      return;
    }
    try {
      res.json({ root, raw: await readStudioRailFile(root) } satisfies StudioRailFileResponse);
    } catch (err) {
      next(err);
    }
  });

  router.put("/api/studio-rail", async (req, res, next) => {
    const root = resolveKnownRoot(req.query.root, await deps.listKnownRoots());
    if (root == null) {
      res.status(400).json({ error: "root must be a known project root" });
      return;
    }
    const raw = (req.body as { raw?: unknown } | undefined)?.raw;
    if (typeof raw !== "string") {
      res.status(400).json({ error: "raw must be a string" });
      return;
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_STUDIO_RAIL_BYTES) {
      res.status(413).json({ error: "studio-rail.json is too large" });
      return;
    }
    try {
      await writeStudioRailFile(root, raw);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/api/studio-rail", async (req, res, next) => {
    const root = resolveKnownRoot(req.query.root, await deps.listKnownRoots());
    if (root == null) {
      res.status(400).json({ error: "root must be a known project root" });
      return;
    }
    try {
      await removeStudioRailFile(root);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
