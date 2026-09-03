/**
 * Versions tab — an agent's release history, and the two writes that change
 * what runs: activating a version and moving a label.
 *
 * Same anatomy as the sibling tabs (Canvas | Steps | Code): the shared
 * `workflow-actions-header` subheader with the agent name left and the one
 * server-provable status right, over a `--pane-pad-x` body.
 *
 * Studio could build and deploy but never showed which version was live — that
 * lived only in the web dashboard and the API. Two rules shape this panel:
 *
 * - **Labelled releases first, then recent unlabelled builds.** A plain
 *   chronological list buries a tagged release under a few untagged deploys;
 *   a labels-only list hides the build you just pushed. Ordering is the
 *   server's (`orderVersions`) so both surfaces agree.
 * - **Confirm only when pinning to an older build.** Returning to the newest
 *   build is a return to normal and needs no ceremony. Pinning backwards stops
 *   later deploys going live, which is worth a second look.
 */
import { useRef, useState } from "react";
import type { JSX } from "react";
import type { AgentVersionView, WorkflowInfo } from "@shared/types";

import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { VersionPicker } from "./VersionPicker";
import { useVersions } from "../lib/use-versions";
import {
  COMPUTED_LABEL,
  localStateLabel,
  needsPinConfirm,
  realLabels,
  shortSha,
  versionLabel,
  whenLabel,
} from "../lib/versions";
import { useDismissable } from "../lib/use-dismissable";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * The confirm shown only for pinning backwards. Names the version and states
 * the consequence outright — that later deploys stop going live is the whole
 * reason this dialog exists.
 */
export function PinConfirm({
  version,
  onCancel,
  onConfirm,
}: {
  version: AgentVersionView;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(true, { onDismiss: onCancel, containerRef: ref });
  const labels = realLabels(version);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        ref={ref}
        className="modal modal-confirm"
        role="alertdialog"
        aria-label="Activate an older version"
        data-testid="version-pin-confirm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          Activate {labels[0] ?? shortSha(version.sha)}?
          <button
            className="theme-toggle modal-close"
            aria-label="Close"
            title="Close"
            onClick={onCancel}
          >
            <Icon name="X" size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-copy">
            This makes {shortSha(version.sha)} the live version now. It also
            pins the agent: later deploys will not go live until you activate
            another version or resume following latest.
          </p>
        </div>
        {/* `modal-actions` is the app's dialog footer — it supplies the row
            layout and the gap between the two buttons. An earlier pass used
            `modal-footer`, which this stylesheet does not define, so the
            buttons sat flush against each other with no spacing at all. */}
        <div className="modal-actions">
          {/* Initial focus lands on the SAFE action, matching EndSessionConfirm:
              Enter keeps the current version, and pinning an older build takes
              a deliberate Tab or click. */}
          <button className="btn-ghost" autoFocus onClick={onCancel}>
            Keep current
          </button>
          <button
            className="btn-primary"
            onClick={onConfirm}
            data-testid="version-pin-confirm-go"
          >
            Activate
          </button>
        </div>
      </div>
    </div>
  );
}

/** Inline label editor on a row: `+ label`, then a one-field commit. */
function LabelAdderInline({
  onCommit,
  disabled,
}: {
  onCommit: (name: string) => void;
  disabled: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  if (!open) {
    return (
      <button
        className="version-label-add"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label="Add a label to this version"
        data-testid="version-label-add"
      >
        <Icon name="Plus" size={11} />
        label
      </button>
    );
  }

  const commit = (): void => {
    const name = value.trim();
    setOpen(false);
    setValue("");
    // Core owns the rules (1–64 chars, `latest` reserved), so an empty string
    // is the only thing worth stopping here — everything else is its verdict.
    if (name) onCommit(name);
  };

  return (
    <input
      className="version-label-input"
      autoFocus
      value={value}
      placeholder="0.0.3"
      aria-label="New label"
      data-testid="version-label-input"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          setOpen(false);
          setValue("");
        }
      }}
    />
  );
}

interface VersionsPanelProps {
  /** The workflow bound to the active session, if any. */
  boundWorkflow: WorkflowInfo | null;
  /** Named in the empty state when an agent is open with no live session. */
  noSessionAgent?: string | null;
}

export function VersionsPanel({
  boundWorkflow,
  noSessionAgent = null,
}: VersionsPanelProps): JSX.Element {
  // `WorkflowInfo.definitionId` is a number; these routes take it as a path
  // segment. Convert once here so the hook and the api client stay string-typed.
  const definitionId =
    boundWorkflow?.definitionId != null
      ? String(boundWorkflow.definitionId)
      : null;
  const {
    view,
    loading,
    error,
    pendingSha,
    activate,
    resumeLatest,
    setLabel,
    removeLabel,
  } = useVersions(definitionId, boundWorkflow?.path ?? null);
  const [confirming, setConfirming] = useState<AgentVersionView | null>(null);

  if (!boundWorkflow) {
    return (
      <EmptyState
        className="versions-panel-empty"
        icon="GitBranch"
        title={
          noSessionAgent
            ? `No running session for ${noSessionAgent}`
            : "No agent bound"
        }
        body={
          noSessionAgent
            ? "Start a session to see this agent's version history here."
            : "Open an agent to see which version is live and roll back."
        }
      />
    );
  }

  // Linked but never deployed: there is genuinely no history, and saying so
  // beats an empty table that reads like a failed load.
  if (!definitionId) {
    return (
      <EmptyState
        className="versions-panel-empty"
        icon="GitBranch"
        title="Not deployed yet"
        body={`${boundWorkflow.name} has no cloud versions. Deploy it and its releases appear here.`}
      />
    );
  }

  const versions = view?.versions ?? [];
  const activeVersion =
    versions.find((v) => v.sha === view?.activeSha) ?? null;
  const localLabel = localStateLabel(view?.local ?? null, versions);
  const localMatchesLive =
    view?.local?.matchesSha != null && view.local.matchesSha === view.activeSha;

  const onRowActivate = (v: AgentVersionView): void => {
    if (v.isActive) return;
    // Forward to the newest build is a return to normal — no ceremony. One
    // shared predicate so this tab and the header picker guard identically.
    if (!needsPinConfirm(versions, v.sha)) {
      void activate(v.sha);
      return;
    }
    setConfirming(v);
  };

  return (
    <div
      className="versions-panel"
      /* `object: "agent"` is not decoration: the remove-label control builds
         its aria-label from a user-authored label name (anything up to 64
         chars), and before-send only redacts labels on clicks marked as
         touching a user-named entity. */
      {...trackingAttrs({ surface: "versions_panel", object: "agent" })}
    >
      <div
        className="workflow-actions-header versions-panel-header"
        data-testid="versions-panel-header"
      >
        <span className="workflow-actions-name">{boundWorkflow.name}</span>
        {/* The question this tab exists to answer — WHICH version is serving
            traffic, and under which label — stated here rather than left to be
            inferred from a `Live` marker somewhere down the list. */}
        {activeVersion ? (
          <span className="versions-live-summary" data-testid="versions-live-summary">
            <span className="version-picker-key">live on cloud</span>
            <strong>{versionLabel(activeVersion)}</strong>
            <span className="versions-sha">{shortSha(activeVersion.sha)}</span>
            {realLabels(activeVersion).length > 1 ? (
              // A version can carry several labels; naming only the first would
              // hide that `production` and `0.0.2` are the same build.
              <span className="versions-live-aka">
                also {realLabels(activeVersion).slice(1).join(", ")}
              </span>
            ) : null}
            {view?.pinned ? <span className="versions-live-pin">pinned</span> : null}
          </span>
        ) : view ? (
          <span className="versions-live-summary" data-testid="versions-live-summary">
            <span className="version-picker-key">live on cloud</span>
            <strong>nothing active</strong>
          </span>
        ) : null}
        {localLabel ? (
          <span
            className={
              "versions-live-summary" + (localMatchesLive ? "" : " is-diverged")
            }
            data-testid="versions-local-summary"
            title={
              localMatchesLive
                ? "Your working copy is the version running in the cloud"
                : "Your working copy differs from what is live — Deploy to publish it"
            }
          >
            <span className="version-picker-key">your files</span>
            <strong>{localLabel}</strong>
          </span>
        ) : null}
        <VersionPicker definitionId={definitionId} projectDir={boundWorkflow.path} />
        {view ? (
          <span className="status-tag" data-testid="versions-count">
            {view.total > view.versions.length
              ? `${view.versions.length} of ${view.total}`
              : `${view.total} version${view.total === 1 ? "" : "s"}`}
          </span>
        ) : null}
      </div>

      <div className="versions-panel-body">
        {/* A pin means later deploys will NOT go live. Without this the agent
            reads as merely up to date, and a deploy that "did nothing" is a
            genuinely confusing afternoon. */}
        {view?.pinned ? (
          <div className="versions-pin-banner" data-testid="versions-pin-banner">
            <Icon name="Info" size={12} />
            <span>
              Pinned — later deploys will not go live until you activate another
              version or resume following latest.
            </span>
            <button
              className="btn-ghost versions-banner-action"
              onClick={() => void resumeLatest()}
              data-testid="versions-resume-latest"
            >
              Resume following latest
            </button>
          </div>
        ) : null}

        {/* A 401 here is almost always a STALE BOOT TOKEN: the harness mints a
            new one every start, so a tab left open across a restart keeps
            sending the old one. Printing the raw status made that read like the
            versions feature was broken. Name the actual remedy. */}
        {error ? (
          <div className="versions-error" role="alert" data-testid="versions-error">
            {/401|unauthor/i.test(error)
              ? "This Studio tab is using an expired token — reload the page (Studio mints a new one each time it starts)."
              : error}
          </div>
        ) : null}

        {loading && versions.length === 0 ? (
          <div className="versions-loading">Loading versions…</div>
        ) : null}

        {!loading && versions.length === 0 && !error ? (
          <EmptyState
            className="versions-panel-empty"
            icon="GitBranch"
            title="No versions yet"
            body={`${boundWorkflow.name} is linked but has no ready build. Deploy it to create the first version.`}
          />
        ) : null}

        {versions.length > 0 ? (
          <ul className="versions-list" data-testid="versions-list">
            {versions.map((v) => {
              const labels = realLabels(v);
              const busy = pendingSha === v.sha;
              return (
                <li
                  key={v.sha}
                  className={
                    "versions-row" +
                    (v.isActive ? " is-active" : "") +
                    (busy ? " is-busy" : "")
                  }
                  data-testid={`version-row-${shortSha(v.sha)}`}
                  data-active={v.isActive || undefined}
                >
                  <span className="versions-sha" title={v.sha}>
                    {shortSha(v.sha)}
                  </span>

                  <span className="versions-labels">
                    {v.tags.includes(COMPUTED_LABEL) ? (
                      // Computed, never stored — so it has no remove control.
                      <span
                        className="version-chip is-computed"
                        title="Computed from the newest ready build — cannot be moved or stored"
                      >
                        latest
                      </span>
                    ) : null}
                    {labels.map((name) => (
                      <span key={name} className="version-chip">
                        {name}
                        <button
                          className="version-chip-remove"
                          aria-label={`Remove label ${name}`}
                          disabled={busy}
                          onClick={() => void removeLabel(name)}
                        >
                          <Icon name="X" size={9} />
                        </button>
                      </span>
                    ))}
                    <LabelAdderInline
                      disabled={busy}
                      onCommit={(name) => void setLabel(name, v.sha)}
                    />
                  </span>

                  {/* No commit means no author and no message — an archive
                      upload has neither, and inventing one would be a lie. */}
                  <span className="versions-when">{whenLabel(v)}</span>
                  <span className="versions-subject">{v.subject || "—"}</span>

                  <span className="versions-status">
                    {v.isActive ? (
                      <span className="status-tag versions-live">
                        {view?.pinned ? "Live · pinned" : "Live"}
                      </span>
                    ) : v.buildStatus !== "ready" ? (
                      <span className="status-tag" title={v.buildStatus}>
                        {v.buildStatus}
                      </span>
                    ) : (
                      <button
                        className="btn-ghost versions-row-action"
                        disabled={busy}
                        onClick={() => onRowActivate(v)}
                        data-testid={`version-activate-${shortSha(v.sha)}`}
                      >
                        {needsPinConfirm(versions, v.sha) ? "Activate" : "Follow latest"}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {confirming ? (
        <PinConfirm
          version={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const sha = confirming.sha;
            setConfirming(null);
            void activate(sha);
          }}
        />
      ) : null}
    </div>
  );
}
