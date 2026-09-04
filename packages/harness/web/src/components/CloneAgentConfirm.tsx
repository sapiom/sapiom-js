import { useRef } from "react";
import type { JSX } from "react";

import { Dialog } from "./Dialog";

/**
 * Confirm before cloning a deep-linked agent that isn't on this machine. Opening
 * `sapiom://agent/<id>` for an agent the user hasn't connected locally offers to
 * clone it — a real git clone + npm install the coding agent runs — so it takes a
 * deliberate click rather than happening silently from a link.
 *
 * Dismisses like every other dialog, because it dismisses through the same
 * shell: Escape and a backdrop click both cancel; only the explicit button
 * clones.
 */
export function CloneAgentConfirm({
  agentLabel,
  onCancel,
  onConfirm,
}: {
  agentLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  // Initial focus lands on the safe action; cloning takes a deliberate Tab or
  // click.
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      role="alertdialog"
      className="modal-confirm"
      testId="clone-agent-confirm"
      title="Clone this agent?"
      onClose={onCancel}
      initialFocusRef={cancelRef}
      /* NO `triggerRef`: this one is opened by a deep link, not by a control
         on screen, so there is nothing to hand focus back to. */
      actions={
        <>
          <button className="btn-ghost" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" data-testid="clone-agent-confirm-btn" onClick={onConfirm}>
            Clone locally
          </button>
        </>
      }
    >
      <p className="modal-copy">
        {agentLabel} isn’t on this machine yet. Cloning checks it out locally — a git clone and
        npm install the coding agent runs — then opens it here.
      </p>
    </Dialog>
  );
}
