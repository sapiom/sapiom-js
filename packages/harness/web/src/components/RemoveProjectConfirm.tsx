import { useRef } from "react";
import type { JSX, RefObject } from "react";

import { describeProjectRemoval } from "../lib/project-membership";
import { Dialog } from "./Dialog";

/**
 * The confirm before a project leaves the rail (SAP-2932).
 *
 * It exists for ONE reason: removing a project ends the live sessions rooted
 * in it, and killing a real PTY never happens on a bare click. Everything else
 * a removal does is reversible by reopening the folder.
 *
 * So the dialog earns its place by being specific rather than cautionary.
 * "Ends 3 running sessions" is a fact about this folder right now; "this may
 * affect running sessions" is a sentence people click through. The count comes
 * from the same plan that does the ending (`project-membership.ts`), so the
 * number shown and the sessions killed cannot disagree.
 *
 * And the copy has to answer the question the word "remove" raises, in the
 * dialog rather than in a tooltip nobody opens: NOTHING on disk is touched.
 * "Remove" must never read as "delete my code" — the folder, the agents, and
 * every file in them stay exactly where they are, and reopening the folder
 * brings the project back with its agents.
 *
 * Dismissal, focus containment and the inert background behind it are the
 * shared `Dialog`'s, not this file's: Escape and a backdrop click both mean
 * "Keep project" here for the same reason and by the same code that they do in
 * every other dialog. What is local is the only thing that is local — the
 * count, the copy, and the fact that the SAFE action opens focused.
 */
export function RemoveProjectConfirm({
  label,
  root,
  runningCount,
  onCancel,
  onConfirm,
  triggerRef,
}: {
  /** The project's rail label — what the user actually reads on the row. */
  label: string;
  /** The absolute path, spelled out: the label can be a widened or shared
   *  name, and this is a destructive action on one specific folder. */
  root: string;
  /** Live sessions this removal will end. */
  runningCount: number;
  onCancel: () => void;
  onConfirm: () => void;
  /** Focus returns here on Escape. */
  triggerRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  // The safe action opens focused: Enter keeps the project. `Dialog` takes no
  // `onSubmit` here for the same reason — a removal is never one Return away.
  const keepRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      role="alertdialog"
      className="modal-confirm"
      testId="remove-project-confirm"
      title={`Remove ${label}?`}
      onClose={onCancel}
      triggerRef={triggerRef}
      initialFocusRef={keepRef}
      /* The dialog's own label carries a PROJECT NAME — a folder the user
         named. Tagged `workspace` so before-send strips it from $el_text
         instead of shipping one analytics row per private project name
         (lib/analytics/before-send.ts, USER_NAMED_OBJECTS). */
      tracking={{ object: "workspace" }}
      actions={
        <>
          <button className="btn-ghost" ref={keepRef} onClick={onCancel}>
            Keep project
          </button>
          <button
            className="btn-danger"
            data-testid="remove-project-confirm-btn"
            onClick={onConfirm}
          >
            Remove project
          </button>
        </>
      }
    >
      {/* The count leads, on its own line, because it is the only destructive
          thing here and the only reason to stop and read. */}
      <p className="modal-copy" data-testid="remove-project-confirm-count">
        {describeProjectRemoval(runningCount)}
      </p>
      <p className="modal-copy">
        {label} and the agents inside it leave the rail. <strong>Nothing on disk is
        touched</strong> — no file is created, moved or deleted, and{" "}
        <code>{root}</code> stays exactly where it is. Open the folder again to bring
        the project back.
      </p>
    </Dialog>
  );
}
