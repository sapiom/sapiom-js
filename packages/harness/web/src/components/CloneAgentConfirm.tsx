import { useRef } from "react";
import type { JSX } from "react";

import { useDismissable } from "../lib/use-dismissable";
import { Icon } from "./Icon";

/**
 * Confirm before cloning a deep-linked agent that isn't on this machine. Opening
 * `sapiom://agent/<id>` for an agent the user hasn't connected locally offers to
 * clone it — a real git clone + npm install the coding agent runs — so it takes a
 * deliberate click rather than happening silently from a link.
 *
 * Dismisses like the other modals: Escape and a backdrop click both cancel; only
 * the explicit button clones.
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
  const confirmRef = useRef<HTMLDivElement>(null);
  useDismissable(true, { onDismiss: onCancel, containerRef: confirmRef });

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        ref={confirmRef}
        className="modal modal-confirm"
        role="alertdialog"
        aria-label="Clone agent"
        data-testid="clone-agent-confirm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          Clone this agent?
          <button className="theme-toggle modal-close" aria-label="Close" title="Close" onClick={onCancel}>
            <Icon name="X" size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-copy">
            {agentLabel} isn’t on this machine yet. Cloning checks it out locally — a git clone and
            npm install the coding agent runs — then opens it here.
          </p>
        </div>
        <div className="modal-actions">
          {/* Initial focus lands on the safe action; cloning takes a deliberate Tab or click. */}
          <button className="btn-ghost" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" data-testid="clone-agent-confirm-btn" onClick={onConfirm}>
            Clone locally
          </button>
        </div>
      </div>
    </div>
  );
}
