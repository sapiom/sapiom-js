/**
 * The secrets atoms, on Studio's own primitives: every label is THE `Pill`,
 * every action is THE icon-button family.
 *
 * The mask is the load-bearing one: a value is never shown again, and unlike
 * the design this is ported from there is no identification hint beside it.
 * The platform's read returns names only, so a hint could be drawn for the
 * values this machine happens to hold and nothing else — a column populated
 * for some rows and blank for others is worse than one that is simply absent.
 */
import type { JSX } from "react";

import { Icon, type IconName } from "./Icon";
import { Pill } from "./Pill";
import type { AgentSecret } from "@shared/types";

/** Write-only representation. Bullets, and only bullets. */
export function ValueMask({ testId }: { testId?: string }): JSX.Element {
  return (
    <span className="secret-mask" data-testid={testId}>
      <span aria-hidden="true">••••</span>
      <span className="visually-hidden">value hidden</span>
    </span>
  );
}

/**
 * Where the value actually IS — the one piece of row metadata the platform can
 * confirm, and the question the tab exists to answer.
 *
 * `pending` is not an error state and must not read as one: it is the normal
 * condition of a credential you set before deploying, which is the whole point
 * of being able to set one that early.
 */
export function SecretStatePill({
  secret,
}: {
  secret: AgentSecret;
}): JSX.Element {
  const synced = secret.state === "synced";
  return (
    <span
      className={"secret-state" + (synced ? " is-synced" : " is-pending")}
      data-testid={`secrets-state-${secret.name}`}
      data-state={secret.state}
    >
      <Icon name={synced ? "Cloud" : "Clock"} size={12} />
      <Pill
        title={
          synced
            ? "Stored on Sapiom — deployed runs receive this value"
            : "Saved on this machine — local runs receive it now, and deploying uploads it"
        }
      >
        {synced ? "synced" : "pending"}
      </Pill>
    </span>
  );
}

/**
 * An icon-only row action on THE icon-button recipe. The label is both the
 * accessible name and the tooltip, so the action stays legible without
 * spending a column on words.
 */
export function SecretAction({
  label,
  icon,
  onClick,
  danger = false,
  disabled = false,
  testId,
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={"theme-toggle" + (danger ? " is-danger" : "")}
      aria-label={label}
      data-tooltip={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}
