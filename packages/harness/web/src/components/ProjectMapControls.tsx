/**
 * The project header's map controls (design-eng agent-studio-v2 AGENT-MAP.md,
 * D70 to D75): in a git project a ref selector (Working copy, HEAD with its
 * branch, then the branches), and a refresh. Outside git, refresh only.
 */
import { useRef, useState, type JSX } from "react";

import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { AnchoredPopover } from "./AnchoredPopover";
import { Icon } from "./Icon";

export interface ProjectMapHeaderControls {
  /** Null outside a git repository. */
  git: { branch: string | null; branches: string[] } | null;
  /** The ref drawn: null is the working copy. */
  mapRef: string | null;
  onSelectRef: (ref: string | null) => void;
  refreshing: boolean;
  onRefresh: () => void;
}

/** The id a choice carries in its testid and in the trigger's `data-ref`. */
const refId = (ref: string | null): string => ref ?? "working";

function RefChoice({
  id,
  icon,
  label,
  meta,
  checked,
  onPick,
}: {
  id: string;
  icon: string;
  label: string;
  meta?: string | null;
  checked: boolean;
  onPick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-testid={`project-map-ref-${id}`}
      className={"session-dropdown-item menu-choice" + (checked ? " is-checked" : "")}
      // Branch names are the user's; keep them out of click analytics text.
      {...trackingAttrs({ object: "workspace" })}
      onClick={onPick}
    >
      <span className="session-item-icon">
        <Icon name={icon} size={13} />
      </span>
      <span className="session-item-copy">
        <span className="session-item-title">{label}</span>
        {meta && <span className="session-item-meta project-map-ref-branch">{meta}</span>}
      </span>
      <span className="menu-choice-mark" aria-hidden="true">
        {checked && <Icon name="Check" size={13} />}
      </span>
    </button>
  );
}

export function ProjectMapControls({ controls }: { controls: ProjectMapHeaderControls }): JSX.Element {
  const { git, mapRef } = controls;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const pick = (ref: string | null): void => {
    setOpen(false);
    if (ref !== mapRef) controls.onSelectRef(ref);
  };
  const branches = git?.branches.filter((branch) => branch !== "HEAD") ?? [];
  return (
    <span className="project-map-controls">
      {git && (
        <>
          <button
            ref={trigger}
            type="button"
            className="status-tag status-tag-action project-map-ref"
            data-testid="project-map-ref"
            data-ref={refId(mapRef)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Version drawn: ${mapRef ?? "Working copy"}`}
            {...trackingAttrs({ object: "workspace" })}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="GitBranch" size={12} />
            <span className="project-map-ref-label">
              {mapRef === null
                ? "Working copy"
                : mapRef === "HEAD" && git.branch
                  ? `HEAD · ${git.branch}`
                  : mapRef}
            </span>
            <Icon name="ChevronDown" size={12} />
          </button>
          <AnchoredPopover
            open={open}
            anchorRef={trigger}
            onDismiss={() => setOpen(false)}
            placement="down-start"
            className="session-menu project-map-ref-menu"
            role="menu"
            testid="project-map-ref-menu"
          >
            <RefChoice
              id="working"
              icon="Folder"
              label="Working copy"
              checked={mapRef === null}
              onPick={() => pick(null)}
            />
            <RefChoice
              id="HEAD"
              icon="GitBranch"
              label="HEAD"
              meta={git.branch}
              checked={mapRef === "HEAD"}
              onPick={() => pick("HEAD")}
            />
            {branches.length > 0 && <div className="session-dropdown-section">Branches</div>}
            {branches.map((branch) => (
              <RefChoice
                key={branch}
                id={branch}
                icon="GitBranch"
                label={branch}
                checked={mapRef === branch}
                onPick={() => pick(branch)}
              />
            ))}
          </AnchoredPopover>
        </>
      )}
      <button
        type="button"
        className={"theme-toggle project-map-refresh" + (controls.refreshing ? " is-refreshing" : "")}
        data-testid="project-map-refresh"
        data-refreshing={controls.refreshing ? "true" : undefined}
        aria-label="Refresh map"
        title="Refresh map"
        aria-busy={controls.refreshing}
        disabled={controls.refreshing}
        onClick={controls.onRefresh}
      >
        <Icon name="RefreshCw" size={13} />
      </button>
    </span>
  );
}
