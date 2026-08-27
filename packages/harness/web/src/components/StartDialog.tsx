import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";

import type { FsListResponse } from "../lib/api";
import { classifyFolder, type FolderOutcome } from "../lib/detect-folder";
import { useDismissable } from "../lib/use-dismissable";
import { DirectoryPicker, type DirectoryResolution } from "./DirectoryPicker";
import { Icon } from "./Icon";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * One folder picker, TWO questions.
 *
 * "Add a project" and "find agents under here" are different questions with
 * one shared input, and the design's "one `+` per question" rule means they
 * cannot be the same control. So they are two controls — the rail header's `+`
 * and the nav row's "Add existing agents" — pointing at this one dialog with
 * `mode` deciding which action is the PRIMARY and which is the secondary.
 * Splitting the picker in two instead would have meant two folder browsers
 * asking the identical question, which is the thing that rule is against.
 *
 * Round 1 had only the detection flow, and the header `+` opened it. So
 * "add a project" was gated behind FINDING AN AGENT IN IT: point it at an empty
 * folder and the ink button stayed disabled, nothing was remembered, and no
 * project row appeared. But a project is a folder the user CHOSE — you open one
 * in order to build the first agent in it, and whether it currently holds an
 * agent is not the question being asked.
 *
 * `mode: "open"` — primary is **Open project**, enabled for any folder that
 * resolves. If detection also found agents, "Add all N" stays as the secondary.
 * `mode: "detect"` — primary is the detection action (Add workspace / Add all
 * N), and "Open folder anyway" is the secondary, so a folder with nothing in it
 * is still a dead end you can walk out of.
 *
 * This dialog never scaffolds, starts a session, or opens templates — those
 * live on their own surfaces, which is why there is no agent picker and no
 * tray.
 */
export type StartMode = "open" | "detect";

interface StartDialogProps {
  /** Which question was asked. Decides the primary action, the title and the
   *  subtitle; both modes offer both actions. */
  mode?: StartMode;
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

  // A folder change means the current outcome is stale — show "Checking…" until
  // the picker re-resolves and detection settles.
  useEffect(() => {
    setChecking(true);
    // A new folder is a new question: the consent given for the last one does
    // not carry over to this one.
    setArmed(false);
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
  /**
   * Whether the bulk scan is worth offering: any folder that EXISTS.
   *
   * Round 1 offered it only for `multi` — a folder with an agent project as an
   * immediate child. But detection probes exactly one level, and the scan walks
   * eight, so `plain` does not mean "no agents here", it means "none in the one
   * level I looked at". On the user's real install that refused `design-eng`
   * outright, because its agent lives at `design-eng/ari/orchestration`.
   *
   * This is the same mismatch as the dishonest count, from the other side: one
   * level's answer was being used to decide an eight-level action. Both are
   * fixed by the same move — stop letting the shallow probe speak for the deep
   * scan, in either direction.
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
   * how many that is: the only number it can compute is the folder's immediate
   * children, and on a real install that read 1 while the click wrote 87
   * registry rows. Those 87 are the "outside your projects" flood.
   *
   * A PREVIEW would be better than a warning, and it is not reachable from
   * here. Computing one client-side means walking `GET /api/fs/list` ourselves,
   * and that listing does not say which directories the scan IGNORES — it only
   * applies the ignore rule to `hasAgentProject` on the entry itself. So a
   * client walk descends into `node_modules` and counts every installed package
   * carrying a `sapiom.json`, which the real scan skips entirely. That trades a
   * number that is too small for one that is too large, which is not an
   * improvement. An honest preview needs a DRY-RUN scan on the server, and that
   * file belongs to the other half of this round — see the report.
   *
   * So: the press states the consequence in the terms that actually bit, and
   * the second press is the consent. Not a confirm dialog — this is one action
   * with two states, and a modal over a modal would be worse than the sentence.
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

  // Enter (from the picker) and ⌘↵ both fire the PRIMARY — which is the whole
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
          <p className="modal-field-hint modal-start-sub">
            {mode === "open"
              ? "Pick a folder to work in. It doesn't need an agent yet — agents (sapiom.json) anywhere inside it appear under it automatically."
              : "Add a folder that already holds an agent project."}
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
            {/* "DIRECTLY inside", not "under". The old copy said "under this
                folder" over a number that only counted one level down, and the
                button then promised that number for an action that walks eight.
                On a real install the dialog said 1 and the click registered 87.
                The count is still worth stating — it is a true fact about the
                folder — but it has to say which question it answered. */}
            {outcome.kind === "multi" &&
              `${outcome.directChildren} agent ${
                outcome.directChildren === 1 ? "project" : "projects"
              } directly inside this folder`}
            {/* "DIRECTLY inside", again. Detection probes exactly ONE level
                down — that is all `GET /api/fs/list` reports — so "no agent in
                this folder" was a claim it had not checked. On a real install
                `design-eng` holds its agent at `design-eng/ari/orchestration`,
                and round 1 answered "No agent in this folder" and DISABLED the
                only action, which is the user's "there is no way to move from
                one state to the other" in its most literal form. */}
            {outcome.kind === "plain" && "No agent directly inside this folder"}
            {outcome.kind === "new" && "This folder doesn't exist yet"}
          </span>
          <span className="aw-result-path" title={path}>
            {path}
          </span>
          {/* THE SENTENCE THAT WAS MISSING. The count above answers "what is
              directly inside?"; this answers "what will adding do?", and they
              are not the same question. Round 1 printed only the first and let
              the button imply it was the second. */}
          {(outcome.kind === "multi" || outcome.kind === "plain") && (
            <span className="aw-result-note" data-testid="aw-scan-reach">
              Detection only looks one level down. Adding searches the whole tree
              beneath this folder, so it can find agents this line cannot see —
              and on a large folder, many more than it names.
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * The footer: one ink PRIMARY chosen by `mode`, and — only when it has
 * something else to offer — the other question's action beside it as a ghost.
 *
 * In `open` mode the primary is always **Open project**, because the question
 * asked was "add a project" and every folder that exists is an answer to it.
 * Detection still runs, and when it found agents the ghost carries them in
 * (`Add all N`), so the two questions stay one press apart without either one
 * pretending to be the other.
 *
 * In `detect` mode the primary is what detection found, exactly as round 1 had
 * it, and the ghost is **Open folder anyway** — the escape from a folder with
 * no agent in it, which is otherwise a disabled button and nothing else.
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
  if (checking || !outcome) {
    return (
      <button className="btn-primary modal-primary-cta" data-testid="start-primary" disabled>
        Checking…
      </button>
    );
  }

  /**
   * NO COUNT ON THE BUTTON.
   *
   * `Add all {n}` printed the number of agent projects DIRECTLY inside the
   * folder onto a control that registers everything eight levels down. On a
   * real install it read `Add all 1` and the press wrote 87 registry rows — the
   * whole of the user's "outside your projects" flood, from one click that
   * promised one row.
   *
   * The number could not simply be corrected: the honest one is only knowable
   * by running the scan (see `armAddAll` for why a client-side preview
   * over-counts instead). A count is a promise, and this one cannot be kept
   * cheaply — so the control stops making it and says what it will DO instead,
   * with the consequence stated before the press that causes it.
   */
  const addAll =
    canScan && outcome.kind !== "project" ? (
      <button
        className={
          (mode === "open" ? "btn-ghost" : "btn-primary modal-primary-cta") +
          (armed ? " is-armed" : "")
        }
        data-testid="aw-add-all"
        data-armed={armed ? "true" : "false"}
        onClick={onScan}
        disabled={busy}
      >
        {busy
          ? "Adding…"
          : armed
            ? "Add them — this can be a lot of rows"
            : "Add every agent under this folder"}
      </button>
    ) : null;

  if (mode === "open") {
    return (
      <>
        {addAll}
        <button
          className="btn-primary modal-primary-cta"
          data-testid="open-project"
          onClick={onOpen}
          disabled={busy || !canOpen}
        >
          {busy ? "Opening…" : "Open project"}
        </button>
      </>
    );
  }

  // `detect`: the folder that holds nothing still gets a way out, so the dialog
  // is never a disabled button and no next step.
  const openAnyway = canOpen ? (
    <button className="btn-ghost" data-testid="open-project" onClick={onOpen} disabled={busy}>
      Open folder anyway
    </button>
  ) : null;

  switch (outcome.kind) {
    case "project":
      return (
        <button className="btn-primary modal-primary-cta" data-testid="aw-add" onClick={onConnect} disabled={busy}>
          {busy ? "Adding…" : "Add workspace"}
        </button>
      );
    case "multi":
      return addAll as JSX.Element;
    case "plain":
      /* NOT a dead end any more. Round 1 rendered a disabled "Add workspace"
         here on the strength of a ONE-LEVEL probe, so a folder whose agents sit
         two levels down could not be added at all. The deep scan is the honest
         answer to "are there agents under here?", so it is what this offers. */
      return (
        <>
          {openAnyway}
          {addAll}
        </>
      );
    case "new":
      return (
        <button className="btn-primary modal-primary-cta" data-testid="start-primary" disabled>
          Add workspace
        </button>
      );
  }
}
