/**
 * ConnectGitHubForm — a compact inline form for cloning a GitHub repository.
 *
 * Shown inside AddProjectMenu when the user picks "Connect to GitHub". Does
 * NOT open a browser auth flow — it relies on the user's existing local git
 * credentials (SSH keys, credential helper, etc.). Public repos work with no
 * credentials; private repos work when git is already authenticated.
 */
import { useRef, useState } from "react";
import type { JSX } from "react";
import type { ConnectGitHubRequest } from "../lib/api";
import { parseGitHubRepoUrl, defaultDirNameFor } from "../lib/github-url";
import { Icon } from "./Icon";

/** Sensible default parent directory for new clones when the server has not
 *  provided one. The server uses ~/sapiom; mirror that here for the preview. */
const FALLBACK_CLONE_PARENT = "~/sapiom";

export interface ConnectGitHubFormProps {
  /** Parent directory for the default target-dir preview. */
  defaultCloneParent?: string;
  /** Perform the actual clone + register and return the new workspace path. */
  onConnect: (req: ConnectGitHubRequest) => Promise<string>;
  /** Called after a successful clone — carries the new path. */
  onSuccess: (path: string) => void;
  /** Navigate back to the menu list. */
  onBack: () => void;
  /** Close the whole popover. */
  onClose: () => void;
}

export function ConnectGitHubForm({
  defaultCloneParent,
  onConnect,
  onSuccess,
  onBack,
  onClose,
}: ConnectGitHubFormProps): JSX.Element {
  const [repoUrl, setRepoUrl] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  const parent = defaultCloneParent ?? FALLBACK_CLONE_PARENT;

  // Derive the default target-dir label from the URL as the user types.
  const parsed = parseGitHubRepoUrl(repoUrl);
  const derivedDirName = parsed ? defaultDirNameFor(parsed) : null;
  const targetDirPlaceholder = derivedDirName ? `${parent}/${derivedDirName}` : `${parent}/<repo-name>`;

  // Client-side URL validation error (shown only after the user has typed something).
  const urlError = repoUrl.trim() && !parsed ? "Not a valid GitHub URL" : null;

  const handleSubmit = async (): Promise<void> => {
    const trimmedUrl = repoUrl.trim();
    if (!trimmedUrl) {
      setError("Repository URL is required.");
      urlInputRef.current?.focus();
      return;
    }
    if (!parsed) {
      setError("Not a valid GitHub URL. Try https://github.com/owner/repo or git@github.com:owner/repo.git");
      urlInputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const req: ConnectGitHubRequest = { repoUrl: trimmedUrl };
      if (targetDir.trim()) req.targetDir = targetDir.trim();
      const path = await onConnect(req);
      onSuccess(path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect-github-form" data-testid="connect-github-form">
      <div className="connect-card-header">
        <button
          type="button"
          className="theme-toggle connect-card-close"
          onClick={onBack}
          aria-label="Back to menu"
          title="Back"
        >
          <Icon name="ArrowLeft" size={13} />
        </button>
        <span>Connect to GitHub</span>
        <button
          type="button"
          className="theme-toggle connect-card-close"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <Icon name="X" size={13} />
        </button>
      </div>

      <div className="connect-card-body connect-github-body">
        <div className="connect-github-field">
          <label className="connect-github-label" htmlFor="github-repo-url">
            Repository URL
          </label>
          <input
            ref={urlInputRef}
            id="github-repo-url"
            type="text"
            className={"modal-input connect-github-input" + (urlError ? " is-error" : "")}
            data-testid="github-repo-url"
            placeholder="https://github.com/owner/repo"
            value={repoUrl}
            onChange={(e) => {
              setRepoUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
            disabled={busy}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          {urlError && (
            <span className="connect-github-field-error" data-testid="github-url-error">
              {urlError}
            </span>
          )}
        </div>

        <div className="connect-github-field">
          <label className="connect-github-label" htmlFor="github-target-dir">
            Target folder
            <span className="connect-github-label-hint"> (optional)</span>
          </label>
          <input
            id="github-target-dir"
            type="text"
            className="modal-input connect-github-input"
            data-testid="github-target-dir"
            placeholder={targetDirPlaceholder}
            value={targetDir}
            onChange={(e) => {
              setTargetDir(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="connect-github-field-hint">
            Leave empty to clone into{" "}
            <code className="connect-github-path-preview">{targetDirPlaceholder}</code>
          </span>
        </div>

        {error && (
          <div className="modal-error" data-testid="connect-github-error">
            {error}
          </div>
        )}

        <div className="connect-github-actions">
          <button type="button" className="btn-ghost" onClick={onBack} disabled={busy}>
            Back
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid="connect-github-submit"
            disabled={busy || !repoUrl.trim()}
            onClick={() => void handleSubmit()}
          >
            {busy ? "Cloning…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
