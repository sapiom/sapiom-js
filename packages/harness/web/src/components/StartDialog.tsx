import { useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";

import type { FsListResponse } from "../lib/api";
import { classifyFolder, type FolderOutcome } from "../lib/detect-folder";
import { useDismissable } from "../lib/use-dismissable";
import { FolderField } from "./FolderField";
import { Icon } from "./Icon";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * One folder dialog, TWO questions.
 *
 * "Add a project" and "add the agents under here" are different questions with
 * one shared input, and the design's "one `+` per question" rule means they
 * cannot be the same control. So they are two controls — the rail header's `+`
 * and the nav row's "Add existing agents" — pointing at this one dialog with
 * `mode` deciding what the single primary action does.
 *
 * `mode: "open"` — **Add project**, the only action. It is enabled for any
 * folder that exists, because a project is a folder the user CHOSE: you open
 * one in order to build the first agent in it, and whether it holds one already
 * is not the question being asked.
 *
 * `mode: "detect"` — the primary is what detection found, and "Open as project"
 * is the escape beside it, so a folder with nothing in it is still a dead end
 * you can walk out of.
 *
 * ONE PRIMARY IN `open` MODE, and that is a deletion, not a compromise.
 * A second ink action, "Add every agent under this folder", used to sit beside
 * it. It did the same thing: `openProject` (use-harness-state.ts) scans the
 * whole tree after remembering the root, so the folder's agents arrive either
 * way. Two buttons, one outcome, and nothing on screen said how they differed.
 *
 * This dialog never scaffolds, starts a session, or opens templates — those
 * live on their own surfaces, which is why there is no agent picker and no
 * tray.
 */
export type StartMode = "open" | "detect";

interface StartDialogProps {
  /** Which question was asked. Decides the primary action and the title. */
  mode?: StartMode;
  recentDirs: string[];
  /** Fallback for the folder the field opens on, after the project root — the
   *  harness home now that launchDir is pinned there. */
  launchDir?: string | null;
  projectRoot?: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  onClose: () => void;
  /** Register an existing agent project (the `project` outcome). */
  onConnect: (cwd: string) => Promise<void>;
  /** Bulk-register every project under a root (the `multi`/`plain` outcome). */
  onScan: (root: string) => Promise<number>;
  /**
   * Remember the folder as a PROJECT — agents or not.
   *
   * OPTIONAL, and its absence is meaningful: the two callers that embed this
   * dialog inside another flow (the overview modal, the composer) are asking
   * only the detection question and have no project list of their own to add
   * to, so they simply do not offer the second action rather than offering one
   * that goes nowhere.
   */
  onOpenProject?: (root: string) => Promise<void>;
  /** The control that opened the dialog — Escape returns focus to it. */
  triggerRef?: RefObject<HTMLElement | null>;
}

export function StartDialog({
  mode = "detect",
  recentDirs,
  launchDir,
  projectRoot,
  listDir,
  onClose,
  onConnect,
  onOpenProject,
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
  /** Whether the bulk scan has been armed — see `armAddAll`. */
  const [armed, setArmed] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  useDismissable(true, { onDismiss: onClose, containerRef: panelRef, triggerRef });

  /**
   * Classify the typed folder, debounced.
   *
   * `classifyFolder` needs no help from the field: it resolves "this folder
   * doesn't exist yet" itself, from the real server's 404 and from the mock's
   * resolve-to-nearest-ancestor alike (see its header). That is what let the
   * in-app directory listing go — nothing but the listing ever needed the
   * picker's own resolution.
   */
  const seqRef = useRef(0);
  useEffect(() => {
    const target = cwd.trim();
    const seq = ++seqRef.current;
    setChecking(true);
    // A new folder is a new question: the consent given for the last one does
    // not carry over to this one.
    setArmed(false);
    if (!target) {
      setOutcome(null);
      setChecking(false);
      return;
    }
    const handle = setTimeout(() => {
      classifyFolder(target, false, listDir)
        .then((next) => {
          if (seq !== seqRef.current) return; // a newer folder won
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
    }, 150);
    return () => clearTimeout(handle);
  }, [cwd, listDir]);

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
  /**
   * Whether the bulk scan is worth offering: any folder that EXISTS.
   *
   * Detection probes exactly one level, and the scan walks eight, so `plain`
   * does not mean "no agents here", it means "none in the one level I looked
   * at". Gating the scan on it refused any folder whose agent sits two levels
   * down — a common real layout — with no way to move from one state to the
   * other.
   */
  const canScan = outcome != null && outcome.kind !== "new" && target !== "";
  // A folder that does not exist yet cannot be opened as a project: the rail
  // would carry a row for a path nothing can list. Everything else can.
  const canOpen =
    onOpenProject != null && Boolean(outcome) && outcome?.kind !== "new" && target !== "";

  const addWorkspace = (): void => void run(() => onConnect(target));
  /**
   * BULK REGISTRATION IS ARMED BEFORE IT FIRES.
   *
   * `POST /api/workflows/scan` walks the whole tree — eight levels, bounded by
   * a node budget — and registers everything it finds. The dialog cannot say
   * how many that is: the only number it could compute is the folder's
   * immediate children, and a folder reported as holding one agent has been
   * measured registering dozens. So the press states the consequence, and the
   * second press is the consent — one action with two states, not a modal over
   * a modal.
   */
  const armAddAll = (): void => {
    if (armed) {
      void run(async () => {
        const found = await onScan(target);
        // Zero found keeps the dialog open so the path can be adjusted — closing
        // on nothing would look like it worked.
        if (found === 0) throw new Error("No agent projects found under this folder.");
      });
      return;
    }
    setArmed(true);
  };
  /**
   * OPEN THE FOLDER AS A PROJECT.
   *
   * The folder is remembered FIRST and unconditionally, so the row appears even
   * if the registration below fails — the user chose this folder, and that
   * choice is the thing being recorded.
   *
   * When the folder is itself an agent project we also register the agent, for
   * the reason the two are one press: "open this folder" and "and show me
   * what's in it" are not a decision anyone wants to be asked to make twice.
   * `connectWorkflow` is idempotent about the folder (its own gate declines to
   * mint a second root for an agent an open project already contains), so the
   * order here cannot produce a duplicate row.
   */
  const openProject = (): void =>
    void run(async () => {
      await onOpenProject?.(target);
      if (outcome?.kind === "project") await onConnect(target);
    });

  // Enter (from the field) and ⌘↵ both fire the PRIMARY — which is the whole
  // point of `mode`: the control the user reached for decides what they meant.
  const submitPrimary = (): void => {
    if (busy || checking || !outcome || !target) return;
    if (mode === "open") {
      if (canOpen) openProject();
      return;
    }
    if (outcome.kind === "project") addWorkspace();
    else if (canScan) armAddAll();
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
        aria-label={mode === "open" ? "Add a project" : "Add existing agents"}
        ref={panelRef}
        onKeyDown={onKeyDown}
        {...trackingAttrs({ dialog: "add_agents" })}
      >
        <div className="modal-header modal-start-header">
          <span className="modal-start-title">
            {mode === "open" ? "Add a project" : "Add existing agents"}
          </span>
          <button className="theme-toggle modal-close" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="modal-body">
          {/* ONE LINE, and it is the only body copy — a title, a line of
              guidance, a folder, one action. What was here before spent three
              sentences on how the scanner works (one level down versus the whole
              tree) to justify a warning nobody could act on. */}
          <p className="modal-field-hint" data-testid="start-hint" aria-live="polite">
            {hintFor({ mode, outcome, checking, armed })}
          </p>

          <section className="modal-section">
            <FolderField
              value={cwd}
              onChange={setCwd}
              onSubmit={submitPrimary}
              /* No chips here: this dialog names a folder to ADD, and the
                 recents are the folders it has already been given. */
              recentDirs={[]}
              listDir={listDir}
            />
          </section>

          {error && <div className="modal-error">{error}</div>}
        </div>

        <div className="modal-actions modal-start-actions">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <PrimaryActions
            mode={mode}
            outcome={outcome}
            checking={checking}
            busy={busy}
            canOpen={canOpen}
            canScan={canScan}
            armed={armed}
            onConnect={addWorkspace}
            onScan={armAddAll}
            onOpen={openProject}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The dialog's single line of guidance.
 *
 * It says what pressing the primary will DO, and nothing about how the folder
 * is inspected — no marker filenames, no "detection", no reach disclaimer. The
 * one case where it stops being guidance and becomes a state is the folder that
 * is not there, which is the only state a person can act on from here.
 */
function hintFor({
  mode,
  outcome,
  checking,
  armed,
}: {
  mode: StartMode;
  outcome: FolderOutcome | null;
  checking: boolean;
  armed: boolean;
}): string {
  if (mode === "open") {
    if (!checking && outcome?.kind === "new") return "That folder doesn't exist yet.";
    return "Choose a folder to work in — any agents inside come with it.";
  }
  if (checking || !outcome) return "Choose a folder that already holds agents.";
  switch (outcome.kind) {
    case "new":
      return "That folder doesn't exist yet.";
    case "project":
      return "This folder is an agent project.";
    default:
      return armed
        ? "Press again to confirm — this adds every agent below this folder."
        : "Adds every agent below this folder.";
  }
}

/**
 * The footer: one ink PRIMARY chosen by `mode`.
 *
 * In `open` mode that is **Add project** and it is the only action, because
 * every folder that exists is an answer to "add a project" and opening one
 * already brings its agents with it.
 *
 * In `detect` mode the primary is what detection found, and **Open as project**
 * sits beside it as a ghost — the escape from a folder with no agent in it,
 * which is otherwise a disabled button and nothing else.
 */
function PrimaryActions({
  mode,
  outcome,
  checking,
  busy,
  canOpen,
  canScan,
  armed,
  onConnect,
  onScan,
  onOpen,
}: {
  mode: StartMode;
  outcome: FolderOutcome | null;
  checking: boolean;
  busy: boolean;
  canOpen: boolean;
  /** Whether the bulk scan is offered at all — any folder that exists. */
  canScan: boolean;
  /** Whether the bulk scan's first press has happened — see `armAddAll`. */
  armed: boolean;
  onConnect: () => void;
  onScan: () => void;
  onOpen: () => void;
}): JSX.Element {
  if (mode === "open") {
    return (
      <button
        className="btn-primary modal-primary-cta"
        data-testid="open-project"
        onClick={onOpen}
        disabled={busy || checking || !canOpen}
      >
        {busy ? "Adding…" : checking ? "Checking…" : "Add project"}
      </button>
    );
  }

  if (checking || !outcome) {
    return (
      <button className="btn-primary modal-primary-cta" data-testid="start-primary" disabled>
        {/* Not "Checking…" once the check has finished: an unreadable folder
            settles with no outcome, and the dialog must not claim to still be
            working on it. The error itself is reported in the body. */}
        {checking ? "Checking…" : "Add agents"}
      </button>
    );
  }

  /**
   * NO COUNT ON THE BUTTON.
   *
   * `Add all {n}` printed the number of agent projects DIRECTLY inside the
   * folder onto a control that registers everything eight levels down — it has
   * been measured reading `Add all 1` over a press that wrote dozens of
   * registry rows. A count is a promise, and this one cannot be kept cheaply —
   * so the control says what it will DO, in a verb, and the consequence is
   * stated in the one hint line above it before the press that causes it.
   */
  const addAll =
    canScan && outcome.kind !== "project" ? (
      <button
        className={"btn-primary modal-primary-cta" + (armed ? " is-armed" : "")}
        data-testid="aw-add-all"
        data-armed={armed ? "true" : "false"}
        onClick={onScan}
        disabled={busy}
      >
        {busy ? "Adding…" : armed ? "Add them all" : "Add agents"}
      </button>
    ) : null;

  // The folder that holds nothing still gets a way out, so the dialog is never
  // a disabled button and no next step.
  const openAsProject = canOpen ? (
    <button className="btn-ghost" data-testid="open-project" onClick={onOpen} disabled={busy}>
      Open as project
    </button>
  ) : null;

  switch (outcome.kind) {
    case "project":
      return (
        <button className="btn-primary modal-primary-cta" data-testid="aw-add" onClick={onConnect} disabled={busy}>
          {busy ? "Adding…" : "Add agent"}
        </button>
      );
    case "multi":
    case "plain":
      /* NOT a dead end. A one-level probe cannot answer "are there agents under
         here?", so the deep scan is what this offers, and the folder can always
         be opened as a project instead. */
      return (
        <>
          {openAsProject}
          {addAll}
        </>
      );
    case "new":
      return (
        <button className="btn-primary modal-primary-cta" data-testid="start-primary" disabled>
          Add agents
        </button>
      );
  }
}
