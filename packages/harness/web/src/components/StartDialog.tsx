import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";

import type { FsListResponse } from "../lib/api";
import { classifyFolder, type FolderOutcome } from "../lib/detect-folder";
import { useDismissable } from "../lib/use-dismissable";
import { DirectoryPicker, type DirectoryResolution } from "./DirectoryPicker";
import { Icon } from "./Icon";

/**
 * Add existing agents.
 *
 * One folder picker; detection decides what the folder is and the single ink
 * action follows: register an agent project (Add workspace), register every
 * project under a container (Add all N), or — when the folder holds no agent —
 * say so and stay disabled. This dialog only ever ADDS agents that already
 * exist; it never scaffolds, starts a session, or opens templates (those live
 * on their own surfaces), which is why there is no agent picker and no tray.
 */
interface StartDialogProps {
  recentDirs: string[];
  /** Fallback for the folder the picker opens on, after the project root — the
   *  harness home now that launchDir is pinned there. */
  launchDir?: string | null;
  projectRoot?: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  onClose: () => void;
  /** Register an existing agent project (the `project` outcome). */
  onConnect: (cwd: string) => Promise<void>;
  /** Bulk-register every project under a root (the `multi` outcome). */
  onScan: (root: string) => Promise<number>;
  /** The control that opened the dialog — Escape returns focus to it. */
  triggerRef?: RefObject<HTMLElement | null>;
}

export function StartDialog({
  recentDirs,
  launchDir,
  projectRoot,
  listDir,
  onClose,
  onConnect,
  onScan,
  triggerRef,
}: StartDialogProps): JSX.Element {
  // Open on the project root (`…/projects`) where agents live, so "Add existing
  // agents" lands on the folder that holds them. Falls back to launchDir (the
  // harness home) then the most recent dir.
  const [cwd, setCwd] = useState(projectRoot ?? launchDir ?? recentDirs[0] ?? "");
  const [outcome, setOutcome] = useState<FolderOutcome | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  useDismissable(true, { onDismiss: onClose, containerRef: panelRef, triggerRef });

  // A folder change means the current outcome is stale — show "Checking…" until
  // the picker re-resolves and detection settles.
  useEffect(() => {
    setChecking(true);
  }, [cwd]);

  // Detection runs off the picker's own resolution (no "Continue", no second
  // fetch): `classifyFolder` only needs the "is this new?" signal the picker
  // already computed, plus one parent-listing for the is-it-a-project check.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const seqRef = useRef(0);
  const handleResolve = useCallback(
    (resolution: DirectoryResolution) => {
      const target = cwdRef.current.trim();
      const seq = ++seqRef.current;
      if (!target) {
        setOutcome(null);
        setChecking(false);
        return;
      }
      classifyFolder(target, resolution.isNew, listDir)
        .then((next) => {
          if (seq !== seqRef.current) return; // a newer resolution won
          setOutcome(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (seq !== seqRef.current) return;
          setOutcome(null);
          setError((err as Error).message);
        })
        .finally(() => {
          if (seq === seqRef.current) setChecking(false);
        });
    },
    [listDir],
  );

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const target = cwd.trim();
  const hasAgent = outcome?.kind === "project" || outcome?.kind === "multi";

  const addWorkspace = (): void => void run(() => onConnect(target));
  const addAll = (): void =>
    void run(async () => {
      const found = await onScan(target);
      // Zero found keeps the dialog open so the path can be adjusted — closing on
      // nothing would look like it worked.
      if (found === 0) throw new Error("No agent projects found under this folder.");
    });

  // The single primary action, decided by what detection found. Enter (from the
  // picker) and ⌘↵ both fire it; a no-agent folder has nothing to add.
  const submitPrimary = (): void => {
    if (busy || checking || !outcome || !target || !hasAgent) return;
    if (outcome.kind === "project") addWorkspace();
    else if (outcome.kind === "multi") addAll();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitPrimary();
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal-start"
        role="dialog"
        aria-label="Add existing agents"
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="modal-header modal-start-header">
          <span className="modal-start-title">Add existing agents</span>
          <button className="theme-toggle modal-close" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-field-hint modal-start-sub">
            Add a folder that already holds an agent project.
          </p>
          <section className="modal-section">
            <DirectoryPicker
              value={cwd}
              onChange={setCwd}
              onSubmit={submitPrimary}
              recentDirs={[]}
              listDir={listDir}
              onResolve={handleResolve}
            />
          </section>

          {outcome && <StatusReadout outcome={outcome} path={target} />}

          {error && <div className="modal-error">{error}</div>}
        </div>

        <div className="modal-actions modal-start-actions">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <PrimaryActions outcome={outcome} checking={checking} busy={busy} onConnect={addWorkspace} onScan={addAll} />
        </div>
      </div>
    </div>
  );
}

/**
 * State the finding; the footer offers the action it implies (or none). A
 * full-bleed hairline-separated block, not a floating card — the dialog's
 * anatomy is header / body / footer blocks.
 */
function StatusReadout({ outcome, path }: { outcome: FolderOutcome; path: string }): JSX.Element {
  const good = outcome.kind === "project" || outcome.kind === "multi";
  return (
    <div className="aw-result" data-tone={good ? "good" : "todo"} data-testid="aw-result" aria-live="polite">
      <div className="aw-result-head">
        <span className="aw-result-glyph" aria-hidden="true">
          <Icon name={good ? "Check" : "TriangleAlert"} size={14} />
        </span>
        <span className="aw-result-text">
          <span className="aw-result-title">
            {outcome.kind === "project" && "This is an agent project"}
            {outcome.kind === "multi" &&
              `${outcome.found} agent ${outcome.found === 1 ? "project" : "projects"} under this folder`}
            {(outcome.kind === "plain" || outcome.kind === "new") && "No agent in this folder"}
          </span>
          <span className="aw-result-path" title={path}>
            {path}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * The morphing primary: exactly one ink button, its label and handler chosen by
 * the detection outcome. A folder with no agent leaves it disabled — there is
 * nothing to add.
 */
function PrimaryActions({
  outcome,
  checking,
  busy,
  onConnect,
  onScan,
}: {
  outcome: FolderOutcome | null;
  checking: boolean;
  busy: boolean;
  onConnect: () => void;
  onScan: () => void;
}): JSX.Element {
  if (checking || !outcome) {
    return (
      <button className="btn-primary modal-primary-cta" data-testid="start-primary" disabled>
        Checking…
      </button>
    );
  }

  switch (outcome.kind) {
    case "project":
      return (
        <button className="btn-primary modal-primary-cta" data-testid="aw-add" onClick={onConnect} disabled={busy}>
          {busy ? "Adding…" : "Add workspace"}
        </button>
      );
    case "multi":
      return (
        <button className="btn-primary modal-primary-cta" data-testid="aw-add-all" onClick={onScan} disabled={busy}>
          {busy ? "Adding…" : `Add all ${outcome.found}`}
        </button>
      );
    case "plain":
    case "new":
      return (
        <button className="btn-primary modal-primary-cta" data-testid="start-primary" disabled>
          Add workspace
        </button>
      );
  }
}
