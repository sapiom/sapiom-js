/**
 * AddProjectMenu — the compact menu that opens from the Workspace "+" button.
 *
 * Three views:
 *   1. menu        — shows "Open Folder" and "Connect to GitHub" items.
 *   2. github-flow — Device Flow (primary): browse + clone repos after
 *                    one-time GitHub authorization. Falls back to URL-paste
 *                    when SAPIOM_GITHUB_CLIENT_ID is not configured.
 *   3. github-url  — URL-paste fallback (ConnectGitHubForm). Always reachable
 *                    via "…or paste a URL" link inside the Device Flow view,
 *                    or directly when the Device Flow is unconfigured.
 */
import { useRef, useState } from "react";
import type { JSX } from "react";
import type { FsListResponse } from "../lib/api";
import type { ConnectGitHubRequest } from "../lib/api";
import type { GitHubDeviceApi } from "./GitHubDeviceConnect";
import { AnchoredPopover } from "./AnchoredPopover";
import { ConnectGitHubForm } from "./ConnectGitHubForm";
import { GitHubDeviceConnect } from "./GitHubDeviceConnect";
import { Icon } from "./Icon";

export interface AddProjectMenuProps {
  /** The "+" button element — the menu anchors to it and returns focus on close. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onDismiss: () => void;
  /** Open the local-folder connect flow. */
  onOpenFolder: () => void;
  /** Called with the API request when the user submits the GitHub URL form.
   *  Should perform the actual clone + register; resolves with the new path. */
  onConnectGitHub: (req: ConnectGitHubRequest) => Promise<string>;
  /** Called after a successful GitHub connect so the caller can select the
   *  new workspace entry. */
  onAfterConnect: (path: string) => void;
  /** Default parent directory for the clone target-dir suggestion. */
  defaultCloneParent?: string;
  /** Adapter that lists a directory — forwarded to the directory picker inside
   *  ConnectGitHubForm (reserved for future use; not wired today). */
  listDir?: (path?: string) => Promise<FsListResponse>;
  /**
   * GitHub Device Flow API adapter. When provided the Device Flow panel is
   * shown as the primary "Connect to GitHub" view; the URL-paste form becomes
   * an explicit fallback. When absent the menu renders only the URL-paste form
   * (same behaviour as before this change, used in tests that don't need the
   * Device Flow).
   */
  githubDeviceApi?: GitHubDeviceApi;
}

type MenuView = "menu" | "github-flow" | "github-url";

export function AddProjectMenu({
  triggerRef,
  open,
  onDismiss,
  onOpenFolder,
  onConnectGitHub,
  onAfterConnect,
  defaultCloneParent,
  githubDeviceApi,
}: AddProjectMenuProps): JSX.Element | null {
  const [view, setView] = useState<MenuView>("menu");

  // Reset to menu view when the popover closes.
  const handleDismiss = (): void => {
    setView("menu");
    onDismiss();
  };

  // When the user picks "Open Folder", close the menu and hand off.
  const handleOpenFolder = (): void => {
    handleDismiss();
    onOpenFolder();
  };

  // When either GitHub view succeeds, close the popover and notify the caller.
  const handleGitHubSuccess = (path: string): void => {
    handleDismiss();
    onAfterConnect(path);
  };

  const menuRef = useRef<HTMLDivElement>(null);

  // Which view to open when the user clicks "Connect to GitHub":
  // prefer the Device Flow if the API adapter is present, else URL paste.
  const handleConnectGitHubClick = (): void => {
    setView(githubDeviceApi ? "github-flow" : "github-url");
  };

  return (
    <AnchoredPopover
      open={open}
      anchorRef={triggerRef}
      onDismiss={handleDismiss}
      placement="down-end"
      className="connect-card add-project-menu"
      testid="add-project-menu"
    >
      {view === "menu" ? (
        <div ref={menuRef} data-testid="add-project-menu-items">
          <div className="connect-card-header">
            <span>Use Existing&hellip;</span>
            <button
              className="theme-toggle connect-card-close"
              onClick={handleDismiss}
              aria-label="Close"
              title="Close"
            >
              <Icon name="X" size={13} />
            </button>
          </div>
          <div className="connect-card-body">
            <button
              type="button"
              className="btn-ghost add-project-menu-item"
              data-testid="add-project-open-folder"
              onClick={handleOpenFolder}
            >
              <Icon name="Folder" size={14} />
              Open Folder
            </button>
            <button
              type="button"
              className="btn-ghost add-project-menu-item"
              data-testid="add-project-connect-github"
              onClick={handleConnectGitHubClick}
            >
              <Icon name="GitBranch" size={14} />
              Connect to GitHub
            </button>
          </div>
        </div>
      ) : view === "github-flow" && githubDeviceApi ? (
        <GitHubDeviceConnect
          api={githubDeviceApi}
          defaultCloneParent={defaultCloneParent}
          onBack={() => setView("menu")}
          onClose={handleDismiss}
          onSuccess={handleGitHubSuccess}
        />
      ) : (
        /* URL-paste fallback — always reachable */
        <ConnectGitHubForm
          defaultCloneParent={defaultCloneParent}
          onConnect={onConnectGitHub}
          onSuccess={handleGitHubSuccess}
          onBack={() => setView("menu")}
          onClose={handleDismiss}
        />
      )}
    </AnchoredPopover>
  );
}
