/**
 * The right pane's Secrets tab: the values THIS agent's runs receive.
 *
 * A secret belongs to one agent, which is the platform's own model (the engine
 * stores them per definition). So this is a list, not a resolution: no scope
 * tiers, no precedence, nothing shadowed.
 *
 * WHAT THIS BUILD ADDS TO THE DESIGN IT IS PORTED FROM. The design shows a gap
 * state for an unlinked agent, because secrets are stored per cloud definition
 * and there is no id to store against before linking. That gate is the actual
 * pain point: you could not set a credential until after the deploy you needed
 * the credential for. So an unlinked agent's values are held locally instead
 * (server: core/pending-secrets.ts), injected into local runs, and uploaded
 * when the agent is deployed. A row therefore carries WHERE it is — `pending`
 * or `synced` — and that is the one piece of row metadata the platform can
 * actually confirm.
 *
 * WHAT IT DROPS. The design's value hint, version pill, Updated and Last used.
 * `GET .../secrets` returns names only, so those could be drawn for the values
 * this machine happens to hold and nothing else — populated for some rows and
 * blank for others is identification you cannot trust.
 */
import { useCallback, useEffect, useState, type JSX } from "react";

import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { Pill } from "./Pill";
import { SecretAddDialog } from "./SecretAddDialog";
import { SecretImportDialog } from "./SecretImportDialog";
import { SecretDeleteDialog, SecretReplaceDialog } from "./SecretRowDialogs";
import { SecretsTable } from "./SecretsTable";
import { errorMessage, type HarnessApi } from "../lib/api";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import type { AgentSecret, AgentSecretsView, WorkflowInfo } from "@shared/types";

type OpenDialog =
  | { kind: "add" }
  | { kind: "import" }
  | { kind: "replace"; secret: AgentSecret }
  | { kind: "delete"; secret: AgentSecret }
  | null;

const EMPTY_VIEW: AgentSecretsView = {
  secrets: [],
  linked: false,
  unreadable: false,
};

export function SecretsPanel({
  api,
  workflow,
  onToast,
}: {
  api: HarnessApi;
  /** The pane's subject. Null when nothing is selected. */
  workflow: WorkflowInfo | null;
  onToast: (message: string) => void;
}): JSX.Element {
  const [view, setView] = useState<AgentSecretsView>(EMPTY_VIEW);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const path = workflow?.path ?? null;

  const reload = useCallback(async (): Promise<void> => {
    if (!path) {
      setView(EMPTY_VIEW);
      setLoading(false);
      return;
    }
    try {
      setView(await api.listSecrets(path));
    } catch {
      // A failed list is the same user-facing fact as an unreadable vault:
      // we could not look. Saying "no secrets" here would invite re-adding a
      // credential that is already there.
      setView({ ...EMPTY_VIEW, unreadable: true });
    } finally {
      setLoading(false);
    }
  }, [api, path]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  /** Every mutation goes through here, so every write reports what it did and
   *  the list is never left disagreeing with the server. */
  const run = useCallback(
    async (action: () => Promise<string | null>): Promise<void> => {
      setBusy(true);
      try {
        const message = await action();
        if (message) onToast(message);
        await reload();
        setDialog(null);
      } catch (err) {
        // Left OPEN on failure: the dialog still holds what the user typed,
        // and closing it would lose the value along with the explanation.
        onToast(errorMessage(err, "That did not go through. Nothing changed."));
      } finally {
        setBusy(false);
      }
    },
    [onToast, reload],
  );

  if (!workflow || !path) {
    return (
      <div className="secrets-panel" data-testid="secrets-panel">
        <EmptyState
          className="secrets-empty"
          icon="Shield"
          testId="secrets-no-agent"
          title="No agent selected"
          body="Open an agent to see the values its runs receive."
        />
      </div>
    );
  }

  const agentName = workflow.name;
  const pendingCount = view.secrets.filter((s) => s.state === "pending").length;

  return (
    <div
      className="secrets-panel"
      data-testid="secrets-panel"
      /* Activates the analytics redaction guard (lib/analytics/before-send.ts):
         click text and every element attribute but class/id are dropped inside
         this container, because a field value or a button label here can BE
         the credential. */
      {...trackingAttrs({ surface: "secrets_panel" })}
    >
      <div className="secrets-header" data-testid="secrets-toolbar">
        <Pill>{agentName}</Pill>
        <Pill variant="count" title="Secrets on this agent">
          <span data-testid="secrets-count">{view.secrets.length}</span>
        </Pill>
      </div>

      <div className="secrets-body">
        {/* The lede sits ON the verbs' row, left anchored: a summary block
            above it would restate the count the toolbar carries. */}
        <div className="secrets-actions">
          <p className="secrets-lede">
            Values every run of {agentName} receives. Stored write-only, so a
            value is never shown again.
          </p>
          <div className="secrets-verbs">
            <button
              type="button"
              className="btn-line"
              data-testid="secrets-import"
              disabled={busy}
              onClick={() => setDialog({ kind: "import" })}
            >
              <Icon name="FileText" size={14} /> Import .env
            </button>
            <button
              type="button"
              className="btn-primary"
              data-testid="secrets-add"
              disabled={busy}
              onClick={() => setDialog({ kind: "add" })}
            >
              <Icon name="Plus" size={14} /> Add secret
            </button>
          </div>
        </div>

        {/* An agent deployed from the TERMINAL never passes through the deploy
            route, so nothing uploaded its pending values. Rather than let that
            fail silently, say it and offer the push. */}
        {view.linked && pendingCount > 0 && (
          <div className="secrets-pending-banner" data-testid="secrets-pending-banner">
            <Icon name="TriangleAlert" size={14} />
            <span>
              {pendingCount} {pendingCount === 1 ? "value is" : "values are"}{" "}
              saved here but not on Sapiom, so deployed runs will not see{" "}
              {pendingCount === 1 ? "it" : "them"}.
            </span>
            <button
              type="button"
              className="btn-line"
              data-testid="secrets-flush"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const report = await api.flushSecrets(path);
                  if (report.failed.length > 0) {
                    // Named, never counted away: the user must know WHICH key
                    // is still missing from the deployed agent.
                    return `Uploaded ${report.uploaded.length}. Failed: ${report.failed
                      .map((f) => f.key)
                      .join(", ")}.`;
                  }
                  return `Uploaded ${report.uploaded.length} to Sapiom.`;
                })
              }
            >
              Upload to Sapiom
            </button>
          </div>
        )}

        {view.unreadable && (
          <div className="secrets-pending-banner is-warning" data-testid="secrets-unreadable">
            <Icon name="CloudOff" size={14} />
            <span>
              This agent&rsquo;s deployed credentials could not be read, so the
              list may be incomplete. Anything saved on this machine is still
              shown.
            </span>
          </div>
        )}

        {/* The table renders either way. Its header is the agent's shape, and
            keeping it means an empty vault reads as a vault with nothing in it
            rather than as a message with nothing under it. */}
        <SecretsTable
          secrets={view.secrets}
          busy={busy}
          onReplace={(secret) => setDialog({ kind: "replace", secret })}
          onDelete={(secret) => setDialog({ kind: "delete", secret })}
          empty={
            <EmptyState
              className="secrets-empty"
              icon="Shield"
              testId="secrets-empty"
              title={loading ? "Loading secrets…" : "No secrets yet"}
              body={
                loading
                  ? undefined
                  : `Runs of ${agentName} start with nothing set. Add a secret, or import a .env.`
              }
            />
          }
        />
      </div>

      {dialog?.kind === "add" && (
        <SecretAddDialog
          secrets={view.secrets}
          agentName={agentName}
          linked={view.linked}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={({ name, value }) =>
            void run(async () => {
              const { state } = await api.setSecret(path, name, value);
              return state === "synced"
                ? `${name} saved to Sapiom.`
                : `${name} saved on this machine. Deploy to upload it.`;
            })
          }
        />
      )}

      {dialog?.kind === "import" && (
        <SecretImportDialog
          secrets={view.secrets}
          agentName={agentName}
          linked={view.linked}
          busy={busy}
          onClose={() => setDialog(null)}
          onImport={(entries) =>
            void run(async () => {
              const report = await api.importSecrets(
                path,
                entries.map((e) => ({ key: e.name, secret: e.value })),
              );
              if (report.failed.length > 0) {
                return `Imported ${report.uploaded.length}. Failed: ${report.failed
                  .map((f) => f.key)
                  .join(", ")}.`;
              }
              return `Imported ${report.uploaded.length} ${
                report.uploaded.length === 1 ? "secret" : "secrets"
              }.`;
            })
          }
        />
      )}

      {dialog?.kind === "replace" && (
        <SecretReplaceDialog
          secret={dialog.secret}
          linked={view.linked}
          busy={busy}
          onClose={() => setDialog(null)}
          onReplace={(secret, value) =>
            void run(async () => {
              await api.setSecret(path, secret.name, value);
              return `${secret.name} replaced.`;
            })
          }
        />
      )}

      {dialog?.kind === "delete" && (
        <SecretDeleteDialog
          secret={dialog.secret}
          agentName={agentName}
          busy={busy}
          onClose={() => setDialog(null)}
          onDelete={(secret, { localOnly }) =>
            void run(async () => {
              await api.deleteSecret(path, secret.name, { localOnly });
              return localOnly
                ? `${secret.name} removed from this machine.`
                : `${secret.name} deleted.`;
            })
          }
        />
      )}
    </div>
  );
}
