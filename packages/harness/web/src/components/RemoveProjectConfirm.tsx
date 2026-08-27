import { useRef } from "react";
import type { JSX, RefObject } from "react";

import { useDismissable } from "../lib/use-dismissable";
import { describeProjectRemoval } from "../lib/project-membership";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { Icon } from "./Icon";

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
 * Dismisses like every other layer: Escape and a backdrop click both mean
 * "Keep project", and Escape hands focus back to the row's control.
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
  const confirmRef = useRef<HTMLDivElement>(null);
  useDismissable(true, { onDismiss: onCancel, containerRef: confirmRef, triggerRef });

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        ref={confirmRef}
        className="modal modal-confirm"
        role="alertdialog"
        aria-label={`Remove ${label}`}
        data-testid="remove-project-confirm"
        /* The dialog's own label carries a PROJECT NAME — a folder the user
           named. Tagged `workspace` so before-send strips it from $el_text
           instead of shipping one analytics row per private project name
           (lib/analytics/before-send.ts, USER_NAMED_OBJECTS). */
        {...trackingAttrs({ object: "workspace" })}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          Remove {label}?
          <button
            className="theme-toggle modal-close"
            aria-label="Close"
            title="Close"
            onClick={onCancel}
          >
            <Icon name="X" size={14} />
          </button>
        </div>
        <div className="modal-body">
          {/* The count leads, on its own line, because it is the only
              destructive thing here and the only reason to stop and read. */}
          <p className="modal-copy" data-testid="remove-project-confirm-count">
            {describeProjectRemoval(runningCount)}
          </p>
          <p className="modal-copy">
            {label} and the agents inside it leave the rail. <strong>Nothing on disk is
            touched</strong> — no file is created, moved or deleted, and{" "}
            <code>{root}</code> stays exactly where it is. Open the folder again to bring
            the project back.
          </p>
        </div>
        <div className="modal-actions">
          {/* Initial focus lands on the SAFE action: Enter keeps the project. */}
          <button className="btn-ghost" autoFocus onClick={onCancel}>
            Keep project
          </button>
          <button
            className="btn-danger"
            data-testid="remove-project-confirm-btn"
            onClick={onConfirm}
          >
            Remove project
          </button>
        </div>
      </div>
    </div>
  );
}
