import { useRef } from "react";
import type { JSX } from "react";

import { Dialog } from "./Dialog";

/** Trust lets the folder's hooks run unprompted beyond Studio, so only a deliberate click grants
 *  it; every other way out leaves Claude Code to ask (SAP-4381). */
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
