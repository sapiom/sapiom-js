/**
 * The agent's secrets. One row per name, because a secret has exactly one
 * owner: no merge, no precedence, no shadowed rows to explain.
 *
 * Four columns, three when the pane is narrow: Status sheds first, because a
 * name you cannot read is worse than a badge you cannot see. The design this
 * is ported from also carried Updated and Last used; the platform serves
 * neither, and a column header over permanently empty cells advertises data
 * that is never coming.
 */
import type { JSX } from "react";

import { SecretAction, SecretStatePill, ValueMask } from "./SecretBits";
import type { AgentSecret } from "@shared/types";

export function SecretsTable({
  secrets,
  empty,
  onReplace,
  onDelete,
  busy,
}: {
  secrets: AgentSecret[];
  /** Shown INSIDE the table when there is nothing to list. The frame stays:
   *  an agent with no secrets still has a shape, and a message floating in
   *  bare panel under a buttons row had nothing to sit in. */
  empty?: JSX.Element;
  onReplace: (secret: AgentSecret) => void;
  onDelete: (secret: AgentSecret) => void;
  /** A write is in flight — row actions are inert until it settles, so a
   *  double-click cannot fire two deletes at one credential. */
  busy?: boolean;
}): JSX.Element {
  return (
    <div className="secrets-table" data-testid="secrets-table">
      <div className="secrets-row secrets-row--head" aria-hidden="true">
        <span>Name</span>
        <span data-col="low">Value</span>
        <span>Status</span>
        <span />
      </div>
      {secrets.length === 0 && empty && (
        <div
          className="secrets-row secrets-row--empty"
          data-testid="secrets-empty-row"
        >
          {empty}
        </div>
      )}
      {secrets.map((secret) => (
        <div
          key={secret.name}
          className="secrets-row"
          data-testid={`secrets-entry-${secret.name}`}
        >
          <span className="secrets-name">{secret.name}</span>
          <span data-col="low">
            <ValueMask />
          </span>
          <span className="secrets-meta">
            <SecretStatePill secret={secret} />
          </span>
          <span className="secrets-row-actions">
            <SecretAction
              label="Replace value"
              icon="Pencil"
              disabled={busy}
              testId={`secrets-replace-${secret.name}`}
              onClick={() => onReplace(secret)}
            />
            <SecretAction
              label="Delete secret"
              icon="Trash2"
              danger
              disabled={busy}
              testId={`secrets-delete-${secret.name}`}
              onClick={() => onDelete(secret)}
            />
          </span>
        </div>
      ))}
    </div>
  );
}
