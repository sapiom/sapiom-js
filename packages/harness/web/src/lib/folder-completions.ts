/**
 * Completion options for the `npx` browser host's folder field.
 *
 * The desktop app has the OS folder browser and never calls this. A browser has
 * no native dialog at all, so this — fed into a native `<datalist>` — is the
 * whole reason a browser user can find a folder by typing rather than reciting
 * an absolute path. Losing it is silent: the field still works, it just stops
 * suggesting anything.
 *
 * Extracted from the component so the ANCESTOR FALLBACK below is reachable by a
 * test. The mock filesystem resolves a missing tail to its nearest existing
 * ancestor itself, so `listDir` never rejects under Playwright and that branch
 * cannot be exercised from the e2e suite — the one place it matters (a real
 * server, mid-type) is the one place no suite was looking.
 */
import type { FsListResponse } from "./api";
import { parentOf } from "./paths";

const childPaths = (res: FsListResponse): string[] => res.dirs.map((dir) => dir.path);

export async function folderCompletions(
  value: string,
  listDir: (path?: string) => Promise<FsListResponse>,
): Promise<string[]> {
  try {
    return childPaths(await listDir(value || undefined));
  } catch {
    // ANCESTOR FALLBACK. The real server 404s a path that does not exist yet,
    // which is every half-typed folder name — so the listing that can actually
    // complete it is the parent's.
    const up = parentOf(value);
    if (!up) return [];
    try {
      return childPaths(await listDir(up));
    } catch {
      // Both unreadable: no suggestions. The host dialog is what reports the
      // failure; a field with an empty datalist is a field with no completion,
      // not an error surface.
      return [];
    }
  }
}
