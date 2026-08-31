/**
 * What a folder IS, decided from its marker files — the single fact the unified
 * Start dialog turns into "the one right action".
 *
 * Lifted verbatim from what used to be `AddWorkspaceDialog`'s `HaveProjectDoor`
 * so both the reactive dialog and its tests share one implementation. The two
 * load-bearing quirks it must preserve:
 *
 *  - `GET /api/fs/list` reports one level DOWN, so a path can only learn whether it
 *    is itself an agent project by listing its PARENT and finding its own entry.
 *  - the real server 404s a path that doesn't exist while the mock resolves up to
 *    the nearest ancestor; comparing the RESOLVED path to what was asked for is the
 *    signal that works for both, and is what stops a typed not-yet-existing folder
 *    from inheriting its ancestor's contents and reporting as "N projects".
 */
import type { FsListResponse } from "./api";
import { stripTrailingSep } from "./paths";
import { parentOf } from "./project-dir";

/** What detection found at a resolved path. */
export type FolderOutcome =
  | { kind: "project" }
  | {
      kind: "multi";
      /**
       * Agent projects sitting DIRECTLY inside this folder — one level down,
       * because that is all `GET /api/fs/list` reports and all this function
       * ever asks for.
       *
       * RENAMED FROM `found`, and the rename is the fix.
       *
       * `found` read as "what adding will find", and the dialog printed it on
       * the ink button: `Add all {found}`. But `POST /api/workflows/scan` walks
       * the whole tree — eight levels, bounded by a node budget — so the two
       * numbers are answers to different questions. Measured on a real install:
       * the button read **Add all 1** and the click registered **87** agents.
       * That single press is where the user's 88-row registry came from, and
       * the flood of "outside your projects" rows this round exists to fix.
       *
       * So the count keeps its honest meaning and loses its false one: it is
       * stated as a fact about the folder's immediate contents, and it is NOT
       * what any button promises. See `StartDialog`'s `PrimaryActions` for why
       * the promise could not simply be corrected to the right number.
       */
      directChildren: number;
    }
  | { kind: "plain" }
  | { kind: "new" };

/** `/a/b/` → `/a/b`, so a user's trailing slash never breaks a path comparison.
 *  Kept under its historical name; the separator handling lives in paths.ts. */
export function stripTrailingSlash(input: string): string {
  return stripTrailingSep(input);
}

/**
 * Classify `target`. `isNew` short-circuits to the not-yet-existing outcome for a
 * caller that already knows; every caller in the app passes `false` and lets this
 * decide, because it can — the resolved-path comparison below and the 404 fallback
 * cover the real server and the mock alike.
 *
 * Throws `"Couldn't read that directory."` only when neither the target nor its
 * parent can be read — every other case is a normal outcome.
 */
export async function classifyFolder(
  target: string,
  isNew: boolean,
  listDir: (path?: string) => Promise<FsListResponse>,
): Promise<FolderOutcome> {
  const t = stripTrailingSlash(target.trim());
  if (!t) return { kind: "new" };
  if (isNew) return { kind: "new" };

  const parent = parentOf(t);
  try {
    // Is the path ITSELF a project? Ask its parent and look for its own entry.
    const self = parent ? await listDir(parent) : null;
    const isProject = Boolean(
      self?.dirs.some((dir) => stripTrailingSlash(dir.path) === t && dir.hasAgentProject),
    );
    if (isProject) return { kind: "project" };

    // Does it CONTAIN projects? Ask the path itself.
    const children = await listDir(t);
    // Resolved somewhere else than asked → the folder doesn't exist yet.
    if (stripTrailingSlash(children.path) !== t) return { kind: "new" };
    const inside = children.dirs.filter((dir) => dir.hasAgentProject).length;
    return inside > 0 ? { kind: "multi", directChildren: inside } : { kind: "plain" };
  } catch {
    // Unreadable target, readable parent → a folder that doesn't exist yet (the
    // real server's 404 path). Both unreadable is a real error.
    if (parent) {
      try {
        await listDir(parent);
        return { kind: "new" };
      } catch {
        throw new Error("Couldn't read that directory.");
      }
    }
    throw new Error("Couldn't read that directory.");
  }
}
