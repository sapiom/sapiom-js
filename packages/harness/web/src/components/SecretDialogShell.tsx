/**
 * The shell every secrets dialog sits in.
 *
 * The design this is ported from builds its dialogs on Radix (`ui/dialog`),
 * which the harness does not have and should not gain for four modals. This is
 * the harness's own idiom instead — `modal-backdrop` > `modal` with
 * `useDismissable`, exactly as EndSessionConfirm does it — so Escape and a
 * backdrop click mean the same thing here as everywhere else in the app.
 *
 * Extracted rather than repeated four times: a dialog that dismissed
 * differently from its three siblings would be a bug nobody notices until a
 * user loses a half-typed credential to it.
 */
import { useRef, type JSX, type ReactNode } from "react";

import { Icon } from "./Icon";
import { useDismissable } from "../lib/use-dismissable";

export function SecretDialogShell({
  title,
  onClose,
  children,
  actions,
  testId,
  role = "dialog",
}: {
  /** Rendered as the modal's accessible name as well as its heading. */
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** The footer row. Cancel first: the safe action is the reachable one. */
  actions: ReactNode;
  testId: string;
  /** `alertdialog` for the destructive one, so assistive tech announces it as
   *  a decision rather than a form. */
  role?: "dialog" | "alertdialog";
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissable(true, { onDismiss: onClose, containerRef });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={containerRef}
        className="modal modal-secret"
        role={role}
        aria-label={typeof title === "string" ? title : undefined}
        data-testid={testId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          {title}
          <button
            type="button"
            className="theme-toggle modal-close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <Icon name="X" size={14} />
          </button>
        </div>
        {children}
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

/** The one consequence line a secrets dialog carries: what saving is about to
 *  do, stated BEFORE the click rather than discovered after it. */
export function SecretNotice({
  children,
  tone = "info",
  testId,
}: {
  children: ReactNode;
  tone?: "info" | "warning" | "ok";
  testId: string;
}): JSX.Element {
  const icon =
    tone === "warning" ? "TriangleAlert" : tone === "ok" ? "Check" : "Info";
  return (
    <p
      className={
        "secret-notice" +
        (tone === "warning" ? " is-warning" : tone === "ok" ? " is-ok" : "")
      }
      data-testid={testId}
    >
      <Icon name={icon} size={14} />
      <span>{children}</span>
    </p>
  );
}
