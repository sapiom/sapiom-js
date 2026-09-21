import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { FsListResponse } from "../lib/api";
import { parentOf, stripTrailingSep } from "../lib/paths";
import { Dialog } from "./Dialog";
import { FolderField } from "./FolderField";

/**
 * The web half of the folder step (flow-creation.md §4.1 step 2, D29).
 *
 * On desktop the OS picker answers "which folder" and this never renders (see
 * `lib/folder-step.ts`). In a browser there is no native dialog, so the
 * smallest fallback that keeps the feature is one path field on the shared
 * dialog shell: a title naming the verb, one line of guidance, the field, one
 * action. It never scans, never detects agents, never starts a session. Where
 * the folder leads is the caller's decision (`intent`): New project continues
 * to the new-agent screen, Add project stops once the folder is in the rail.
 */
export type ProjectFolderIntent = "new-project" | "add-project";

/**
 * Whether a typed folder exists, with the same rule both hosts honour: the
 * real server 404s a missing path (unreadable target, readable parent), and
 * the mock resolves to the nearest ancestor (a listing whose `path` is not
 * the one asked for). Throws only when neither the target nor its parent can
 * be read, which is a real error rather than a missing folder.
 */
export async function folderExists(
  target: string,
  listDir: (path?: string) => Promise<FsListResponse>,
): Promise<boolean> {
  const t = stripTrailingSep(target.trim());
  if (!t) return false;
  try {
    const listed = await listDir(t);
    return stripTrailingSep(listed.path) === t;
  } catch {
    const parent = parentOf(t);
    if (!parent) throw new Error("Couldn't read that directory.");
    try {
      await listDir(parent);
      return false;
    } catch {
      throw new Error("Couldn't read that directory.");
    }
  }
}

export function ProjectFolderDialog({
  intent,
  initialPath,
  listDir,
  onClose,
  onChoose,
}: {
  intent: ProjectFolderIntent;
  /** Where the field opens: the most recent folder, or empty. */
  initialPath: string;
  listDir: (path?: string) => Promise<FsListResponse>;
  onClose: () => void;
  /** The folder the user settled on. Rejects with a sentence to show. */
  onChoose: (root: string) => Promise<void>;
}): JSX.Element {
  const [path, setPath] = useState(initialPath);
  const [exists, setExists] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced existence check: a folder that is not there cannot be opened as
  // a project, and the rail would carry a row for a path nothing can list.
  const seqRef = useRef(0);
  useEffect(() => {
    const target = path.trim();
    const seq = ++seqRef.current;
    setChecking(true);
    if (!target) {
      setExists(null);
      setChecking(false);
      return;
    }
    const handle = setTimeout(() => {
      folderExists(target, listDir)
        .then((found) => {
          if (seq !== seqRef.current) return;
          setExists(found);
          setError(null);
        })
        .catch((err: unknown) => {
          if (seq !== seqRef.current) return;
          setExists(null);
          setError((err as Error).message);
        })
        .finally(() => {
          if (seq === seqRef.current) setChecking(false);
        });
    }, 150);
    return () => clearTimeout(handle);
  }, [path, listDir]);

  const target = path.trim();
  const canContinue = exists === true && target !== "" && !checking && !busy;

  const submit = (): void => {
    if (!canContinue) return;
    setBusy(true);
    setError(null);
    onChoose(target)
      .then(() => onClose())
      .catch((err: unknown) => {
        setError((err as Error).message);
        setBusy(false);
      });
  };

  const title = intent === "new-project" ? "New project" : "Add project";
  const primary =
    intent === "new-project"
      ? busy
        ? "Opening…"
        : "Continue"
      : busy
        ? "Adding…"
        : "Add project";
  const hint =
    !checking && exists === false
      ? "That folder doesn't exist yet."
      : intent === "new-project"
        ? "Choose the folder this project lives in. Your agents go inside it."
        : "Choose a folder to work in. Any agents inside come with it.";

  return (
    <Dialog
      className="modal-start modal-project-folder"
      testId="project-folder-dialog"
      title={title}
      onClose={onClose}
      onSubmit={submit}
      dismissable={!busy}
      closeDisabled={busy}
      tracking={{ dialog: "project_folder" }}
      actions={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary modal-primary-cta"
            data-testid="project-folder-continue"
            onClick={submit}
            disabled={!canContinue}
          >
            {checking && target ? "Checking…" : primary}
          </button>
        </>
      }
    >
      <p
        className="modal-field-hint"
        data-testid="project-folder-hint"
        aria-live="polite"
      >
        {hint}
      </p>
      <section className="modal-section">
        <FolderField
          value={path}
          onChange={setPath}
          onSubmit={submit}
          recentDirs={[]}
          listDir={listDir}
        />
      </section>
      {error && (
        <div className="modal-error" data-testid="project-folder-error">
          {error}
        </div>
      )}
    </Dialog>
  );
}
