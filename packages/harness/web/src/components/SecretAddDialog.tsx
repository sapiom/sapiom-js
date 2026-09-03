/**
 * Adding a secret to THIS agent: a short form with live validation and the
 * consequence messaged BEFORE saving, never discovered after. Values are
 * write-only from submit on.
 *
 * There is no assignment control, because a secret has one owner. An earlier
 * pass of the design carried the webapp's account/workflow/session picker;
 * that ladder is a demo construct, not a platform tier (see lib/secrets.ts).
 */
import { useEffect, useMemo, useState, type JSX } from "react";

import { SecretDialogShell, SecretNotice } from "./SecretDialogShell";
import { normalizeSecretName, validateSecretName } from "../lib/secrets";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import type { AgentSecret } from "@shared/types";

export function SecretAddDialog({
  secrets,
  agentName,
  linked,
  busy,
  onClose,
  onSubmit,
}: {
  /** This agent's existing secrets, to warn before a silent replace. */
  secrets: AgentSecret[];
  agentName: string;
  /** Drives the one line that says WHERE this value is about to land. */
  linked: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; value: string }) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");

  // A fresh form every time it mounts: a half-typed name from last time is
  // never what this open meant.
  useEffect(() => {
    setName("");
    setValue("");
  }, []);

  const error = validateSecretName(name);
  const duplicate = useMemo(
    () => (name ? secrets.find((secret) => secret.name === name) : undefined),
    [name, secrets],
  );
  const canSubmit = Boolean(name && value.trim() && !error && !busy);
  const submit = (): void => {
    if (canSubmit) onSubmit({ name, value: value.trim() });
  };

  return (
    <SecretDialogShell
      title="Add secret"
      testId="secret-add-dialog"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid="secret-add-submit"
            disabled={!canSubmit}
            onClick={submit}
          >
            {busy ? "Saving…" : duplicate ? "Replace value" : "Add secret"}
          </button>
        </>
      }
    >
      <form
        className="modal-body"
        {...trackingAttrs({ surface: "secrets_panel", object: "secret" })}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="modal-copy">
          Available to every run of {agentName}. Stored write-only, so the value
          is not shown again.
        </p>

        <label className="modal-field">
          <span className="modal-field-label">Name</span>
          <input
            autoFocus
            className="modal-input"
            data-testid="secret-name-input"
            value={name}
            onChange={(event) => setName(normalizeSecretName(event.target.value))}
            placeholder="STRIPE_API_KEY"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(error)}
          />
          {error && (
            <span className="modal-field-hint secret-field-error" role="alert">
              {error}
            </span>
          )}
        </label>

        <label className="modal-field">
          <span className="modal-field-label">Value</span>
          <input
            className="modal-input"
            data-testid="secret-value-input"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste the value"
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        {duplicate && (
          <SecretNotice tone="warning" testId="secret-duplicate-notice">
            {name} already exists on this agent. Saving replaces its value.
          </SecretNotice>
        )}
        {/* WHERE it lands, said before the click. An unlinked agent has no
            cloud definition to store against, and a user who does not know
            that reads "saved" as "deployed". */}
        <SecretNotice testId="secret-destination-notice">
          {linked
            ? "Applies to new runs; runs already in flight keep the value they started with. A copy is also kept on this machine, so local runs get the same value."
            : "Saved on this machine and used by local runs. Deploying this agent uploads it to Sapiom."}
        </SecretNotice>
        {/* Submits the form on Enter without adding a second visible button. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </SecretDialogShell>
  );
}
