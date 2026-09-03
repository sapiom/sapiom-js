/**
 * The live-version chip beside the agent name: shows what is running now, and
 * drops down the recent versions so switching is one click from anywhere in
 * Studio rather than a trip to the Versions tab.
 *
 * Mirrors the run picker two elements over — same `AnchoredPopover`, same
 * chip-as-trigger shape — so the header keeps one idiom.
 *
 * Deliberately reuses {@link PinConfirm} from the Versions tab instead of
 * writing a second dialog: the guard is the same decision (pinning backwards
 * stops later deploys going live), and two copies would drift apart in wording.
 */
import { useRef, useState } from "react";
import type { JSX } from "react";

import { AnchoredPopover } from "./AnchoredPopover";
import { Icon } from "./Icon";
import { PinConfirm } from "./VersionsPanel";
import { useVersions } from "../lib/use-versions";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import {
  localStateLabel,
  needsPinConfirm,
  realLabels,
  shortSha,
  versionLabel,
} from "../lib/versions";
import type { AgentVersionView } from "@shared/types";

export function VersionPicker({
  definitionId,
  projectDir = null,
}: {
  /** Null for a project that is linked but never deployed — renders nothing. */
  definitionId: string | null;
  /** Absolute project dir, so the chip can also state the LOCAL copy. */
  projectDir?: string | null;
}): JSX.Element | null {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<AgentVersionView | null>(null);
  const { view, pendingSha, activate } = useVersions(definitionId, projectDir);

  // Nothing deployed, or history not loaded: the header stays as it was rather
  // than showing an empty control that implies a missing version.
  if (!definitionId || !view || view.versions.length === 0) return null;

  const versions = view.versions;
  const active = versions.find((v) => v.sha === view.activeSha) ?? null;
  const localLabel = localStateLabel(view.local, versions);
  // "Matches live" is stricter than "is deployed": the local copy can be a
  // deployed version that is NOT the one currently serving traffic.
  const localMatchesLive =
    view.local?.matchesSha != null && view.local.matchesSha === view.activeSha;

  const choose = (v: AgentVersionView): void => {
    setOpen(false);
    if (v.sha === view.activeSha) return;
    // Same shared predicate the Versions tab uses, so the guard cannot differ
    // between the two places a version can be switched.
    if (!needsPinConfirm(versions, v.sha)) {
      void activate(v.sha);
      return;
    }
    setConfirming(v);
  };

  return (
    <>
      <button
        ref={triggerRef}
        /* The trigger's aria-label carries a user-authored version label, so
           this click is marked as touching a user-named entity. The redaction
           gate's regex does not catch a ternary-formatted label — the leak is
           the same, so it is tagged deliberately rather than by detection. */
        {...trackingAttrs({ surface: "version_picker", object: "agent" })}
        className="btn-ghost version-picker"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          active
            ? `Live version ${versionLabel(active)} — pick another`
            : "Pick a version"
        }
        data-tooltip="Pick the live version"
        data-testid="version-picker"
        disabled={pendingSha !== null}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Both halves, named. The cloud version is what a triggered run
            executes; the local one is what a Deploy would upload — and they
            drift apart the moment you edit a file, so showing only one of them
            makes "which am I looking at?" unanswerable. */}
        <span className="version-picker-part">
          <span className="version-picker-key">cloud</span>
          {active ? versionLabel(active) : "none"}
          {view.pinned ? (
            <span title="Pinned — later deploys will not go live">·&nbsp;pinned</span>
          ) : null}
        </span>
        {localLabel ? (
          <span
            className={
              "version-picker-part" +
              (localMatchesLive ? "" : " is-diverged")
            }
            title={
              localMatchesLive
                ? "Your working copy is the version running in the cloud"
                : "Your working copy differs from what is live — Deploy to publish it"
            }
          >
            <span className="version-picker-key">local</span>
            {localLabel}
          </span>
        ) : null}
        <Icon name="ChevronDown" size={11} />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onDismiss={() => setOpen(false)}
        placement="down-end"
        className="version-picker-menu"
        role="menu"
        testid="version-picker-menu"
      >
        {versions.map((v) => {
          const isLive = v.sha === view.activeSha;
          const ready = v.buildStatus === "ready";
          return (
            <button
              key={v.sha}
              role="menuitemradio"
              aria-checked={isLive}
              aria-current={isLive || undefined}
              className="version-picker-item"
              title={v.sha}
              disabled={!ready && !isLive}
              data-testid={`version-picker-option-${shortSha(v.sha)}`}
              onClick={() => choose(v)}
            >
              <Icon name={isLive ? "Check" : "History"} size={13} />
              <span className="versions-sha">{shortSha(v.sha)}</span>
              <span>{realLabels(v).join(" · ") || (ready ? "unlabelled" : v.buildStatus)}</span>
              {/* Which row your files currently are — the answer to "what am I
                  about to overwrite if I deploy?" */}
              {view.local?.matchesSha === v.sha ? (
                <span className="version-picker-local-tag">your local copy</span>
              ) : null}
            </button>
          );
        })}
      </AnchoredPopover>
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
    </>
  );
}
