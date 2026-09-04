/**
 * The harness's one dialog.
 *
 * WHY THIS EXISTS. Studio had eleven hand-rolled dialogs and no primitive: every
 * one opened `<div className="modal-backdrop"><div className="modal" role="dialog">`
 * and then re-decided, independently, whether Tab could leave, where focus
 * landed, whether the backdrop dismissed, and whether the page behind it was
 * still reachable. They did not agree. `SecretDialogShell` had already made this
 * argument for the four secrets dialogs — "a dialog that dismissed differently
 * from its three siblings would be a bug nobody notices" — and the same
 * reasoning simply never reached the create/add/remove family, which is why
 * Tab used to walk straight out of "Create an agent" into the rail behind it.
 *
 * WHAT IT IS. Presentation only: the scrim, the surface, and the
 * header / body / footer geometry, with the ARIA wired once. It renders what it
 * is given and decides nothing. Every behavior — dismissal policy, focus
 * containment, initial and restored focus, the inert background — is
 * `useDialogBehavior`, and the pure decisions inside that (which index Tab lands
 * on, which control opens focused) are `lib/dialog-focus.ts`, where they are
 * unit-testable without a DOM. Form state stays in the consumer, which is the
 * one thing a shared dialog must never own.
 *
 * WHAT IT IS NOT. It is not a port of `@sapiom/design-system`'s `DialogSurface`,
 * and it must not become one: that package is private and this repo is public.
 * The LOOK conforms to it — the same anatomy widgets.md names, "inert
 * background, focus containment, Escape/outside dismissal, close control, and
 * header/footer geometry" — through this app's own CSS classes and this app's
 * own React. No Radix, no copied code, tokens read with `var()`.
 */
import { useId, useRef, type JSX, type ReactNode, type RefObject } from "react";

import { trackingAttrs, type TrackingContext } from "../lib/analytics/tracking-attrs";
import { useDialogBehavior } from "../lib/use-dialog-behavior";
import { Icon } from "./Icon";

export interface DialogProps {
  /**
   * The heading, and — through `aria-labelledby` — the accessible name. One
   * string in one place: the eleven dialogs each carried a hand-written
   * `aria-label` beside a visible title, and four of them had already drifted
   * apart from it.
   */
  title: ReactNode;
  /** The body. The shell supplies `.modal-body`; consumers supply content. */
  children: ReactNode;
  /** The footer row. Cancel first: the safe action is the reachable one. */
  actions: ReactNode;
  /** `alertdialog` for a destructive decision, so assistive tech announces it
   *  as a choice rather than a form. */
  role?: "dialog" | "alertdialog";
  onClose: () => void;
  /**
   * Enter's meaning inside the dialog, if it has one.
   *
   * ONE rule for every dialog, rather than the two that had grown: Enter
   * submits, ⌘/Ctrl+Enter submits from a textarea too, and a focused button or
   * link keeps Enter for itself — pressing Return on Cancel must cancel, not
   * submit. A field that has already handled Enter (the folder picker
   * preventDefaults it) is left alone. Omitted on the destructive confirms on
   * purpose: a removal is never one stray Return away.
   */
  onSubmit?: () => void;
  /** Whether Escape and an outside press dismiss. `false` mid-flight. */
  dismissable?: boolean;
  /** Disables the header's ×, for the same mid-flight reason. */
  closeDisabled?: boolean;
  /** The control that opened the dialog — focus returns here on close. */
  triggerRef?: RefObject<HTMLElement | null>;
  /** The control that opens focused. Defaults to the first one below the
   *  header, never the × . */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Variant classes on the surface: `modal-start`, `modal-confirm`, … */
  className?: string;
  testId?: string;
  /** Click attribution for the whole dialog and everything inside it. */
  tracking?: TrackingContext;
}

export function Dialog({
  title,
  children,
  actions,
  role = "dialog",
  onClose,
  onSubmit,
  dismissable = true,
  closeDisabled = false,
  triggerRef,
  initialFocusRef,
  className,
  testId,
  tracking,
}: DialogProps): JSX.Element {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const titleId = useId();

  useDialogBehavior({
    containerRef: surfaceRef,
    headerRef,
    onDismiss: onClose,
    dismissable,
    triggerRef,
    initialFocusRef,
  });

  return (
    <div className="modal-backdrop">
      <div
        ref={surfaceRef}
        className={["modal", "modal-shell", className].filter(Boolean).join(" ")}
        role={role}
        /* Screen readers that honour it treat the rest of the page as gone;
           the ones that don't are covered by the real `inert` the behavior
           hook sets. Both, because neither is enough alone. */
        aria-modal="true"
        aria-labelledby={titleId}
        /* Focus has to have somewhere to land in a dialog with no controls at
           all — see `initialFocusIndex`. */
        tabIndex={-1}
        data-testid={testId}
        {...(tracking ? trackingAttrs(tracking) : {})}
        onKeyDown={(event) => {
          if (!onSubmit || event.key !== "Enter" || event.defaultPrevented) return;
          const tag = (event.target as HTMLElement).tagName;
          if (tag === "BUTTON" || tag === "A") return;
          if (tag === "TEXTAREA" && !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          onSubmit();
        }}
      >
        <header className="modal-header" ref={headerRef}>
          <div className="modal-title-group">
            <h2 className="modal-title" id={titleId}>
              {title}
            </h2>
          </div>
          {/* Plain "Close": the dialog's own name already scopes it, and
              interpolating the title makes every accessible-name query for the
              title match this button too. */}
          <button
            type="button"
            className="theme-toggle modal-close"
            aria-label="Close"
            title="Close"
            disabled={closeDisabled}
            onClick={onClose}
          >
            <Icon name="X" size={14} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-actions">{actions}</footer>
      </div>
    </div>
  );
}
