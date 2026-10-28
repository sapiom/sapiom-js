import { useRef } from "react";
import type { JSX } from "react";

import { Dialog } from "./Dialog";

/**
 * Ask before trusting a project folder for Claude Code (SAP-4381). Trust lets
 * the folder's own Claude Code settings and hooks run without Claude Code's
 * prompt, here and in every later `claude` run there, so it takes a
 * deliberate click. Escape, a backdrop click and "Not now" all leave the
 * folder untrusted; the session still starts and Claude Code asks itself.
 */
export function TrustFolderConfirm({
  root,
  onAnswer,
}: {
  root: string;
  onAnswer: (trust: boolean) => void;
}): JSX.Element {
  // Initial focus lands on the safe action; trusting takes a deliberate Tab or
  // click.
  const notNowRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      role="alertdialog"
      className="modal-confirm"
      testId="trust-folder-confirm"
      title="Trust this folder?"
      onClose={() => onAnswer(false)}
      initialFocusRef={notNowRef}
      /* NO `triggerRef`: a session start opens it, not a control that keeps
         focus, so there is nothing to hand focus back to. */
      actions={
        <>
          <button className="btn-ghost" ref={notNowRef} onClick={() => onAnswer(false)}>
            Not now
          </button>
          <button className="btn-primary" data-testid="trust-folder-confirm-btn" onClick={() => onAnswer(true)}>
            Trust folder
          </button>
        </>
      }
    >
      <p className="modal-copy">
        Claude Code will run this folder’s own settings and hooks without asking, in Agent Studio
        and whenever you run <code>claude</code> there. Only trust a folder whose code you trust.
      </p>
      <p className="modal-copy">
        <code>{root}</code>
      </p>
    </Dialog>
  );
}
