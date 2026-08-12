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
  | { kind: "multi"; found: number }
  | { kind: "plain" }
  | { kind: "new" };

/** `/a/b/` → `/a/b`, so a user's trailing slash never breaks a path comparison.
 *  Kept under its historical name; the separator handling lives in paths.ts. */
export function stripTrailingSlash(input: string): string {
  return stripTrailingSep(input);
}

/**
 * Classify `target`. `isNew` is the picker's own "this names a folder that doesn't
 * exist yet" signal (from `DirectoryPicker`'s `onResolve`), taken on trust because
 * it already did the listing that decides it.
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
    return inside > 0 ? { kind: "multi", found: inside } : { kind: "plain" };
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
