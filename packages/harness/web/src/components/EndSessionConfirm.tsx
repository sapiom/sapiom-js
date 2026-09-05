import { useRef } from "react";
import type { JSX, RefObject } from "react";

import { Dialog } from "./Dialog";

/**
 * The one confirm dialog before a live session ends — ending it kills a real
 * PTY, so it never happens on a bare click. It is opened from the active
 * session tab's options menu.
 *
 * Dismissal, focus containment and the inert background are the shared
 * `Dialog`'s: Escape and a backdrop click both mean "Keep session" here by the
 * same code that makes them mean the safe thing everywhere else. Only the
 * explicit danger button ends the session, and the dialog takes no `onSubmit`
 * so a stray Return cannot reach it.
 */
export function EndSessionConfirm({
  onCancel,
  onConfirm,
  triggerRef,
  description =
    "This kills the live terminal; anything the agent is doing right now stops. The session stays resumable from history once it has an agent session id.",
}: {
  onCancel: () => void;
  onConfirm: () => void;
  /** Focus returns here on Escape. */
  triggerRef?: RefObject<HTMLElement | null>;
  /** Surface-specific consequence while retaining one confirmation primitive. */
  description?: string;
}): JSX.Element {
  // Initial focus lands on the SAFE action: Enter keeps the session; ending it
  // takes a deliberate Tab or click.
  const keepRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      role="alertdialog"
      className="modal-confirm"
      testId="end-session-confirm"
      title="End session?"
      onClose={onCancel}
      triggerRef={triggerRef}
      initialFocusRef={keepRef}
      actions={
        <>
          <button className="btn-ghost" ref={keepRef} onClick={onCancel}>
            Keep session
          </button>
          <button className="btn-danger" data-testid="end-session-confirm-btn" onClick={onConfirm}>
            End session
          </button>
        </>
      }
    >
      <p className="modal-copy">{description}</p>
    </Dialog>
  );
}
