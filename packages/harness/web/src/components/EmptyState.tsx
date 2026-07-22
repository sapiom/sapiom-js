import type { JSX, ReactNode } from "react";

import { Icon } from "./Icon";

export interface EmptyStateProps {
  /** Optional mono eyebrow above the title ("Session agent"). */
  eyebrow?: string;
  /** Optional glyph in the shared dashed badge. */
  icon?: string;
  title: string;
  /** One supporting line: what is absent and the move that fills it. */
  body?: ReactNode;
  /** At most one call to action. */
  cta?: ReactNode;
  /** Surface-specific class(es) layered on the shared recipe
   *  ("canvas-empty" keeps the dotted board, tests keep their hooks). */
  className?: string;
  testId?: string;
  /** Extra rows under the CTA (the chat empty's starter pills). */
  children?: ReactNode;
}

/**
 * The one "nothing here yet" recipe (voice rule: absence is a state with a
 * next action). Every empty surface — chat, canvas, steps, skills, terminal,
 * rail — renders through this component so the type scale, glyph treatment,
 * and CTA hierarchy never drift apart. Copy stays surface-specific: name
 * what is absent, teach the single move that fills it, never apologize.
 */
export function EmptyState({
  eyebrow,
  icon,
  title,
  body,
  cta,
  className,
  testId,
  children,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={"empty-state" + (className ? ` ${className}` : "")}
      data-empty-state
      data-testid={testId}
    >
      {icon && (
        <span className="empty-state-icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
      )}
      {eyebrow && <span className="empty-state-eyebrow">{eyebrow}</span>}
      <span className="empty-state-title">{title}</span>
      {body && <span className="empty-state-body">{body}</span>}
      {cta && <span className="empty-state-cta">{cta}</span>}
      {children}
    </div>
  );
}
