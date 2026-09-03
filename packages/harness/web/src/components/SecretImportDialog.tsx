/**
 * Bulk import: paste .env text, see what parsed AND what did not, before
 * anything is written. Values follow the same write-only rule as a single add.
 *
 * Skipped lines are named rather than dropped. A silent import that lands four
 * of six keys is the failure this preview exists to prevent — and because the
 * upstream write takes one key per request, the same failure can happen on the
 * WRITE side too, so the panel reports per-key results as well.
 */
import { useMemo, useState, type JSX } from "react";

import { SecretDialogShell, SecretNotice } from "./SecretDialogShell";
import { parseDotEnv } from "../lib/secrets";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import type { AgentSecret } from "@shared/types";

const PLACEHOLDER = `# Paste .env lines
ANTHROPIC_API_KEY=sk-ant-…
STRIPE_API_KEY="sk_live_…"
export SLACK_WEBHOOK_URL=https://hooks.slack.com/…`;

export function SecretImportDialog({
  secrets,
  agentName,
  linked,
  busy,
  onClose,
  onImport,
}: {
  /** This agent's existing secrets, to count what an import would replace. */
  secrets: AgentSecret[];
  agentName: string;
  linked: boolean;
  busy: boolean;
  onClose: () => void;
  onImport: (entries: { name: string; value: string }[]) => void;
}): JSX.Element {
  const [text, setText] = useState("");

  const parsed = useMemo(() => parseDotEnv(text), [text]);
  const replacing = useMemo(
    () =>
      parsed.entries.filter((entry) =>
        secrets.some((secret) => secret.name === entry.name),
      ).length,
    [parsed.entries, secrets],
  );
  const canSubmit = parsed.entries.length > 0 && !busy;

  return (
    <SecretDialogShell
      title="Import .env"
      testId="secret-import-dialog"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid="secret-import-submit"
            disabled={!canSubmit}
            onClick={() => canSubmit && onImport(parsed.entries)}
          >
            {busy
              ? "Importing…"
              : parsed.entries.length > 0
                ? `Import ${parsed.entries.length}`
                : "Import"}
          </button>
        </>
      }
    >
      <div
        className="modal-body"
        {...trackingAttrs({ surface: "secrets_panel", object: "secret" })}
      >
        <p className="modal-copy">
          Paste KEY=VALUE lines. Comments and export prefixes are ignored.
          Values are stored write-only against {agentName}.
        </p>
        <label className="modal-field">
          <span className="modal-field-label">.env contents</span>
          <textarea
            className="modal-input secret-env-input"
            data-testid="secret-import-input"
            rows={7}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
          />
        </label>
        {text.trim() && (
          <div className="secret-import-summary" aria-live="polite">
            <SecretNotice tone="ok" testId="secret-import-ready">
              {parsed.entries.length}{" "}
              {parsed.entries.length === 1 ? "secret" : "secrets"} ready
              {replacing > 0
                ? `, ${replacing} replacing an existing value`
                : ""}
            </SecretNotice>
            {parsed.invalid.length > 0 && (
              <SecretNotice tone="warning" testId="secret-import-skipped">
                {parsed.invalid.length}{" "}
                {parsed.invalid.length === 1 ? "line" : "lines"} skipped:{" "}
                <span className="secret-hint">
                  {parsed.invalid.slice(0, 3).join("  ·  ")}
                </span>
                {parsed.invalid.length > 3
                  ? ` and ${parsed.invalid.length - 3} more`
                  : ""}
              </SecretNotice>
            )}
            {!linked && (
              <SecretNotice testId="secret-import-destination">
                Saved on this machine. Deploying this agent uploads them to
                Sapiom.
              </SecretNotice>
            )}
          </div>
        )}
      </div>
    </SecretDialogShell>
  );
}
