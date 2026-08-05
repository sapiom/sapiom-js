import { useRef } from "react";
import type { JSX, RefObject } from "react";

import "../styles/github-connect.css";
import { useDismissable } from "../lib/use-dismissable";
import {
  GitHubDeviceConnect,
  type GitHubDeviceApi,
} from "./GitHubDeviceConnect";
import { Icon } from "./Icon";

interface GitHubConnectDialogProps {
  api: GitHubDeviceApi;
  defaultCloneParent?: string | null;
  onClose: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
}

/**
 * GitHub is a separate source on the composer-first home, not a mode inside
 * the existing-folder dialog. Keeping this wrapper independent preserves the
 * redesigned folder detection flow and gives Device OAuth one focused task.
 */
export function GitHubConnectDialog({
  api,
  defaultCloneParent,
  onClose,
  triggerRef,
}: GitHubConnectDialogProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissable(true, {
    onDismiss: onClose,
    containerRef: panelRef,
    triggerRef,
  });

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal-start modal-github-connect"
        role="dialog"
        aria-label="Connect GitHub"
        ref={panelRef}
      >
        <div className="modal-header modal-start-header">
          <span className="modal-start-title">Connect GitHub</span>
          <button
            type="button"
            className="theme-toggle modal-close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <Icon name="X" size={14} />
          </button>
        </div>

        <div className="modal-body github-connect-dialog-body">
          <p className="modal-field-hint">
            Authorize GitHub, then choose a repository to clone into Agent
            Studio.
          </p>
          <GitHubDeviceConnect
            api={api}
            defaultCloneParent={defaultCloneParent}
            onSuccess={onClose}
          />
        </div>

        <div className="modal-actions modal-start-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
