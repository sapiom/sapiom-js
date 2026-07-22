import { useRef } from "react";
import type { JSX, RefObject } from "react";

import { useDismissable } from "../lib/use-dismissable";
import { Icon } from "./Icon";

/**
 * The one confirm dialog before a live session ends — ending it kills a real
 * PTY, so it never happens on a bare click. Shared by the session bar's ⋯
 * menu (the active session) and the tab strip's × (any tab), so the copy and
 * the safe-default focus never drift between the two entry points.
 *
 * Dismisses like every other layer: Escape and a backdrop click both
 * mean "Keep session", and Escape hands focus back to the control the flow
 * started from. Only the explicit danger button ends the session.
 */
export function EndSessionConfirm({
  onCancel,
  onConfirm,
  triggerRef,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  /** Focus returns here on Escape (the ⋯ button or the tab's × that opened it). */
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
        aria-label="End session"
        data-testid="end-session-confirm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          End session?
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
          <p className="modal-copy">
            This kills the live terminal; anything the agent is doing right now stops. The session
            stays resumable from history once it has an agent session id.
          </p>
        </div>
        <div className="modal-actions">
          {/* Initial focus lands on the SAFE action: Enter keeps the session;
              ending it takes a deliberate Tab or click. */}
          <button className="btn-ghost" autoFocus onClick={onCancel}>
            Keep session
          </button>
          <button className="btn-danger" data-testid="end-session-confirm-btn" onClick={onConfirm}>
            End session
          </button>
        </div>
      </div>
    </div>
  );
}
