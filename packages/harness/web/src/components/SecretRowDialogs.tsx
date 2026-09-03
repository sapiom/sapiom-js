/**
 * The two row-level flows: replace a value (write-only, the current value
 * stays hidden, the name is locked) and delete with the consequence stated.
 *
 * Delete is an alertdialog whose safe default is Cancel, the same contract
 * EndSessionConfirm keeps: a destructive verb is never one stray Enter away.
 */
import { useState, type JSX } from "react";

import { SecretDialogShell, SecretNotice } from "./SecretDialogShell";
import { ValueMask } from "./SecretBits";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import type { AgentSecret } from "@shared/types";

export function SecretReplaceDialog({
  secret,
  linked,
  busy,
  onClose,
  onReplace,
}: {
  secret: AgentSecret;
  linked: boolean;
  busy: boolean;
  onClose: () => void;
  onReplace: (secret: AgentSecret, value: string) => void;
}): JSX.Element {
  const [value, setValue] = useState("");
  const canSubmit = Boolean(value.trim()) && !busy;
  const submit = (): void => {
    if (canSubmit) onReplace(secret, value.trim());
  };

  return (
    <SecretDialogShell
      title={<span className="secret-dialog-name">{secret.name}</span>}
      testId="secret-replace-dialog"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid="secret-replace-submit"
            disabled={!canSubmit}
            onClick={submit}
          >
            {busy ? "Replacing…" : "Replace value"}
          </button>
        </>
      }
    >
      <div
        className="modal-body"
        {...trackingAttrs({ surface: "secrets_panel", object: "secret" })}
      >
        <p className="modal-copy">
          Enter a new value. The current one stays hidden — there is no way to
          read a stored secret back, by design.
        </p>
        <div className="secret-current">
          <span className="modal-field-label">Current value</span>
          <ValueMask testId="secret-current-mask" />
        </div>
        <label className="modal-field">
          <span className="modal-field-label">New value</span>
          <input
            autoFocus
            className="modal-input"
            data-testid="secret-replace-input"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Paste the replacement value"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <SecretNotice testId="secret-replace-notice">
          {linked
            ? "Applies to new runs. Existing runs keep the value they started with."
            : "Saved on this machine. Deploying this agent uploads it to Sapiom."}
        </SecretNotice>
      </div>
    </SecretDialogShell>
  );
}

export function SecretDeleteDialog({
  secret,
  agentName,
  busy,
  onClose,
  onDelete,
}: {
  secret: AgentSecret;
  agentName: string;
  busy: boolean;
  onClose: () => void;
  /** `localOnly` drops this machine's copy and leaves the deployed credential
   *  in place — offered only when both actually exist. */
  onDelete: (secret: AgentSecret, options: { localOnly: boolean }) => void;
}): JSX.Element {
  // Both copies exist, so "delete" is genuinely ambiguous and the dialog must
  // not guess which one the user meant.
  const bothCopies = secret.state === "synced" && secret.hasLocalCopy;

  return (
    <SecretDialogShell
      role="alertdialog"
      title={<span className="secret-dialog-name">Delete {secret.name}?</span>}
      testId="secret-delete-dialog"
      onClose={onClose}
      actions={
        <>
          {/* Initial focus lands on the SAFE action: Enter cancels; deleting
              takes a deliberate Tab or click. */}
          <button type="button" className="btn-ghost" autoFocus onClick={onClose}>
            Cancel
          </button>
          {bothCopies && (
            <button
              type="button"
              className="btn-ghost"
              data-testid="secret-delete-local-only"
              disabled={busy}
              onClick={() => onDelete(secret, { localOnly: true })}
            >
              Remove local copy only
            </button>
          )}
          <button
            type="button"
            className="btn-danger"
            data-testid="secret-delete-confirm"
            disabled={busy}
            onClick={() => onDelete(secret, { localOnly: false })}
          >
            {busy ? "Deleting…" : "Delete secret"}
          </button>
        </>
      }
    >
      <div
        className="modal-body"
        {...trackingAttrs({ surface: "secrets_panel", object: "secret" })}
      >
        <p className="modal-copy">
          {secret.state === "synced"
            ? `New runs of ${agentName} will no longer receive ${secret.name}. Runs already in flight keep it.`
            : `${secret.name} is only saved on this machine, so nothing deployed changes.`}
        </p>
        <SecretNotice tone="warning" testId="secret-delete-notice">
          {/* The value is unrecoverable and the user cannot check first,
              because nothing can read a stored secret back. */}
          The value cannot be recovered — you will need to paste it again.
        </SecretNotice>
        {bothCopies && (
          <SecretNotice testId="secret-delete-scope-notice">
            This name is stored on Sapiom <em>and</em> on this machine. Deleting
            removes both; “Remove local copy only” leaves the deployed
            credential working.
          </SecretNotice>
        )}
      </div>
    </SecretDialogShell>
  );
}
