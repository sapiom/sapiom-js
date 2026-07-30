/**
 * GitHubDeviceConnect — Device Flow UI for connecting to GitHub.
 *
 * Flow:
 *  1. Not connected: primary "Connect GitHub" button → POST /api/github/device/start
 *     → shows user_code + "Open github.com/login/device" link → polls until done.
 *  2. Connected: shows the signed-in login + a searchable repo list.
 *     Pick a repo → clone + connectPath → appears in the Workspace rail.
 *  3. Manual fallback: "…or paste a repo URL" opens the existing form.
 *
 * When SAPIOM_GITHUB_CLIENT_ID is unset the server returns 503 with
 * { error: "notConfigured" }. On that response this component hides the
 * Device Flow UI entirely and renders the URL-paste fallback inline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ConnectGitHubRequest } from "../lib/api";
import { relativeTimeLabel } from "../lib/relative-time";
import { Icon } from "./Icon";

// ---------------------------------------------------------------------------
// Wire types (not shared/types — these are only consumed client-side).
// ---------------------------------------------------------------------------

interface DeviceStartResponse {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
  expires_in: number;
}

interface PollResult {
  status: "authorized" | "pending" | "slow_down" | "expired" | "denied";
  interval?: number;
}

interface GitHubStatusResponse {
  connected: boolean;
  configured?: boolean;
  login?: string;
}

export interface GitHubRepoEntry {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  description: string | null;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// API helpers (injected via props so tests can mock them).
// ---------------------------------------------------------------------------

export interface GitHubDeviceApi {
  /** POST /api/github/device/start */
  deviceStart(): Promise<DeviceStartResponse>;
  /** POST /api/github/device/poll */
  devicePoll(deviceCode: string): Promise<PollResult>;
  /** GET /api/github/repos */
  listRepos(): Promise<GitHubRepoEntry[]>;
  /** GET /api/github/status */
  status(): Promise<GitHubStatusResponse>;
  /** POST /api/github/disconnect */
  disconnect(): Promise<void>;
  /** Clone the repo and register it (reuses existing connect-github route). */
  clone(req: ConnectGitHubRequest): Promise<string>;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GitHubDeviceConnectProps {
  /** API adapter — production wires RealGitHubDeviceApi; tests inject a stub. */
  api: GitHubDeviceApi;
  /** Parent directory for target-dir default preview (mirrors ConnectGitHubForm). */
  defaultCloneParent?: string;
  /** Called when the URL-paste fallback "Back" button is clicked. */
  onBack: () => void;
  /** Close the whole popover. */
  onClose: () => void;
  /** Called after a successful clone with the new workspace path. */
  onSuccess: (path: string) => void;
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

type View =
  | { kind: "loading" }          // initial status check
  | { kind: "unconfigured" }     // no client ID — show URL-paste fallback hint
  | { kind: "idle" }             // not connected, ready to start
  | { kind: "awaiting"; userCode: string; verificationUri: string; deviceCode: string; intervalSec: number }
  | { kind: "polling" }          // polling after user clicked the link
  | { kind: "error"; message: string }
  | { kind: "connected"; login: string }
  | { kind: "repos"; login: string; repos: GitHubRepoEntry[]; query: string }
  | { kind: "cloning"; repoFullName: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const FALLBACK_CLONE_PARENT = "~/sapiom";

export function GitHubDeviceConnect({
  api,
  defaultCloneParent,
  onBack,
  onClose,
  onSuccess,
}: GitHubDeviceConnectProps): JSX.Element {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const parent = defaultCloneParent ?? FALLBACK_CLONE_PARENT;

  // The parent passes a fresh `api` object on every render (inline literal), and
  // it re-renders ~every 2s (run polling). Keep the latest api in a ref so the
  // one-time mount status check never needs `api` in its dep array — otherwise it
  // would re-fire and reset an in-progress authorization back to idle.
  const apiRef = useRef(api);
  apiRef.current = api;

  // Clear any pending timers on unmount.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // On mount ONLY: resolve the initial state (connected / unconfigured / idle).
  // Every transition is guarded to fire from "loading" alone, so a late-resolving
  // status() can never overwrite a flow the user already started (awaiting /
  // polling / connected). Keyed to [] so it runs exactly once — apiRef holds the
  // latest api without re-firing this effect on every parent render.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await apiRef.current.status();
        if (cancelled) return;
        if (s.configured === false) {
          setView((v) => (v.kind === "loading" ? { kind: "unconfigured" } : v));
          return;
        }
        if (s.connected && s.login) {
          const login = s.login;
          setView((v) => (v.kind === "loading" ? { kind: "connected", login } : v));
        } else {
          setView((v) => (v.kind === "loading" ? { kind: "idle" } : v));
        }
      } catch {
        if (!cancelled) setView((v) => (v.kind === "loading" ? { kind: "idle" } : v));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Poll ──────────────────────────────────────────────────────────────────
  // Declared before handleStart so it can be referenced in handleStart's
  // useCallback without a temporal dead-zone error.

  const schedulePoll = useCallback(
    (deviceCode: string, intervalSec: number): void => {
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = setTimeout(() => {
        void (async () => {
          try {
            const result = await api.devicePoll(deviceCode);
            switch (result.status) {
              case "authorized": {
                // Fetch the login to show in the connected state.
                try {
                  const s = await api.status();
                  setView({ kind: "connected", login: s.login ?? "you" });
                } catch {
                  setView({ kind: "connected", login: "you" });
                }
                break;
              }
              case "pending":
                schedulePoll(deviceCode, intervalSec);
                break;
              case "slow_down":
                schedulePoll(deviceCode, (result.interval ?? intervalSec) + 5);
                break;
              case "expired":
                setView({ kind: "error", message: "The authorization code expired. Please try again." });
                break;
              case "denied":
                setView({ kind: "error", message: "Authorization was denied." });
                break;
            }
          } catch (err) {
            setView({ kind: "error", message: (err as Error).message ?? "Polling failed" });
          }
        })();
      }, intervalSec * 1000);
    },
    [api],
  );

  // ── Start Device Flow ────────────────────────────────────────────────────

  const handleStart = useCallback(async (): Promise<void> => {
    setView({ kind: "loading" });
    try {
      const res = await api.deviceStart();
      const intervalSec = res.interval ?? 5;

      // Auto-copy the code so the user can paste it on GitHub immediately.
      void navigator.clipboard?.writeText(res.user_code).catch(() => {});

      setView({
        kind: "awaiting",
        userCode: res.user_code,
        verificationUri: res.verification_uri,
        deviceCode: res.device_code,
        intervalSec,
      });

      // Auto-start polling — Studio connects itself once the user authorizes.
      schedulePoll(res.device_code, intervalSec);
    } catch (err) {
      const msg = (err as Error).message ?? "Failed to start GitHub authorization";
      if (msg.includes("notConfigured") || msg.includes("503")) {
        setView({ kind: "unconfigured" });
      } else {
        setView({ kind: "error", message: msg });
      }
    }
  }, [api, schedulePoll]);

  // ── Load repos ────────────────────────────────────────────────────────────

  const handleLoadRepos = useCallback(
    async (login: string): Promise<void> => {
      setView({ kind: "loading" });
      try {
        const repos = await api.listRepos();
        setView({ kind: "repos", login, repos, query: "" });
      } catch (err) {
        setView({ kind: "error", message: (err as Error).message ?? "Failed to load repos" });
      }
    },
    [api],
  );

  // ── Clone ─────────────────────────────────────────────────────────────────

  const handleClone = useCallback(
    async (repo: GitHubRepoEntry): Promise<void> => {
      setCloneError(null);
      setView({ kind: "cloning", repoFullName: repo.fullName });
      try {
        const path = await api.clone({
          repoUrl: repo.cloneUrl,
          // targetDir left absent → server derives from repo name under the parent
        });
        onSuccess(path);
      } catch (err) {
        const msg = (err as Error).message ?? "Clone failed";
        // Return to repos list with an error banner.
        setCloneError(msg);
        // Recover: re-fetch repos (login may have changed if token expired).
        try {
          const s = await api.status();
          if (s.connected && s.login) {
            const repos = await api.listRepos();
            setView({ kind: "repos", login: s.login, repos, query: "" });
          } else {
            setView({ kind: "idle" });
          }
        } catch {
          setView({ kind: "idle" });
        }
      }
    },
    [api, onSuccess],
  );

  // ── Disconnect ────────────────────────────────────────────────────────────

  const handleDisconnect = useCallback(async (): Promise<void> => {
    try {
      await api.disconnect();
    } catch {
      // Best-effort
    }
    setView({ kind: "idle" });
  }, [api]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="connect-github-form" data-testid="github-device-connect">
      {/* Header */}
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

      {/* Body */}
      <div className="connect-card-body connect-github-body">
        {view.kind === "loading" && (
          <div className="github-device-loading" data-testid="github-device-loading">
            <Icon name="Loader" size={14} />
            <span>Loading…</span>
          </div>
        )}

        {view.kind === "unconfigured" && (
          <div className="github-device-unconfigured" data-testid="github-device-unconfigured">
            <p className="connect-github-field-hint">
              GitHub connect is not configured — paste a repo URL instead.
            </p>
          </div>
        )}

        {view.kind === "idle" && (
          <>
            <p className="connect-github-field-hint">
              Authorize once to browse and clone your repositories.
            </p>
            <div className="connect-github-actions">
              <button
                type="button"
                className="btn-primary"
                data-testid="github-device-start"
                onClick={() => void handleStart()}
              >
                <Icon name="GitBranch" size={14} />
                Connect GitHub
              </button>
            </div>
          </>
        )}

        {view.kind === "awaiting" && (
          <div className="github-device-awaiting" data-testid="github-device-awaiting">
            <p className="connect-github-label">
              Enter this code on GitHub to connect
            </p>
            <div className="github-device-code" data-testid="github-device-code">
              {view.userCode}
            </div>
            <p className="connect-github-field-hint github-device-clipboard-hint" data-testid="github-device-clipboard-hint">
              Copied to your clipboard
            </p>
            <ol className="github-device-steps connect-github-field-hint">
              <li>Copy this code (done for you ✓)</li>
              <li>Click <strong>Open GitHub</strong> → click <strong>Continue</strong></li>
              <li>Paste the code (⌘V / Ctrl+V) and click <strong>Authorize</strong></li>
            </ol>
            <div className="connect-github-actions github-device-code-actions">
              <button
                type="button"
                className="btn-ghost github-device-copy"
                data-testid="github-device-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(view.userCode).catch(() => {});
                  setCodeCopied(true);
                  if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
                  copyTimerRef.current = setTimeout(() => setCodeCopied(false), 2000);
                }}
              >
                <Icon name="Copy" size={13} />
                {codeCopied ? "Copied ✓" : "Copy"}
              </button>
              <a
                href={view.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary github-device-link"
                data-testid="github-device-link"
              >
                <Icon name="ExternalLink" size={14} />
                Open GitHub
              </a>
            </div>
            <p className="connect-github-field-hint github-device-waiting" data-testid="github-device-waiting">
              <Icon name="Loader" size={13} />
              Waiting for authorization…
            </p>
          </div>
        )}

        {view.kind === "polling" && (
          <div className="github-device-awaiting" data-testid="github-device-awaiting">
            <p className="connect-github-field-hint github-device-waiting">
              <Icon name="Loader" size={13} />
              Waiting for authorization…
            </p>
          </div>
        )}

        {view.kind === "error" && (
          <>
            <div className="modal-error" data-testid="github-device-error">
              {view.message}
            </div>
            <div className="connect-github-actions">
              <button
                type="button"
                className="btn-ghost"
                data-testid="github-device-retry"
                onClick={() => void handleStart()}
              >
                Try again
              </button>
            </div>
          </>
        )}

        {view.kind === "connected" && (
          <>
            <div className="github-device-connected" data-testid="github-device-connected">
              <Icon name="Check" size={14} />
              <span>
                Signed in as <strong>{view.login}</strong>
              </span>
            </div>
            <div className="connect-github-actions">
              <button
                type="button"
                className="btn-ghost github-device-disconnect"
                data-testid="github-device-disconnect"
                onClick={() => void handleDisconnect()}
              >
                Disconnect
              </button>
              <button
                type="button"
                className="btn-primary"
                data-testid="github-device-browse"
                onClick={() => void handleLoadRepos(view.login)}
              >
                Browse repos
              </button>
            </div>
          </>
        )}

        {(view.kind === "repos" || view.kind === "cloning") && (
          <RepoList
            login={view.kind === "repos" ? view.login : ""}
            repos={view.kind === "repos" ? view.repos : []}
            query={view.kind === "repos" ? view.query : ""}
            cloning={view.kind === "cloning" ? view.repoFullName : null}
            cloneError={cloneError}
            parent={parent}
            onQueryChange={(q) =>
              setView((v) =>
                v.kind === "repos" ? { ...v, query: q } : v,
              )
            }
            onClone={handleClone}
            onDisconnect={() => void handleDisconnect()}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repo list sub-view.
// ---------------------------------------------------------------------------

function RepoList({
  login,
  repos,
  query,
  cloning,
  cloneError,
  parent,
  onQueryChange,
  onClone,
  onDisconnect,
}: {
  login: string;
  repos: GitHubRepoEntry[];
  query: string;
  cloning: string | null;
  cloneError: string | null;
  parent: string;
  onQueryChange: (q: string) => void;
  onClone: (repo: GitHubRepoEntry) => void;
  onDisconnect: () => void;
}): JSX.Element {
  const filtered = repos.filter((r) =>
    r.fullName.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="github-repo-list-wrap" data-testid="github-repo-list">
      {/* Account header: login + subtle disconnect */}
      <div className="github-device-connected-bar">
        <Icon name="Check" size={12} />
        <span className="github-repo-account-login">{login}</span>
        <button
          type="button"
          className="github-device-disconnect-inline"
          data-testid="github-device-disconnect"
          onClick={onDisconnect}
        >
          Disconnect
        </button>
      </div>

      {/* Search */}
      <div className="connect-github-field">
        <input
          type="text"
          className="modal-input connect-github-input"
          data-testid="github-repo-search"
          placeholder="Search repos…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {cloneError && (
        <div className="modal-error" data-testid="github-clone-error">
          {cloneError}
        </div>
      )}

      {/* List */}
      <div className="github-repo-list" data-testid="github-repo-list-items">
        {filtered.length === 0 ? (
          <p className="github-repo-empty">No repositories match.</p>
        ) : (
          filtered.map((repo) => {
            const slashIdx = repo.fullName.indexOf("/");
            const owner = slashIdx >= 0 ? repo.fullName.slice(0, slashIdx + 1) : "";
            const repoName = slashIdx >= 0 ? repo.fullName.slice(slashIdx + 1) : repo.fullName;
            const isCloning = cloning === repo.fullName;
            const updatedLabel =
              repo.updatedAt
                ? relativeTimeLabel(new Date(repo.updatedAt).getTime())
                : null;
            return (
              <button
                key={repo.fullName}
                type="button"
                className={"github-repo-item" + (isCloning ? " is-cloning" : "")}
                data-testid={`github-repo-item-${repoName}`}
                disabled={cloning !== null}
                onClick={() => onClone(repo)}
                title={`Clone into ${parent}/${repoName}`}
              >
                {/* Leading icon */}
                <span className="github-repo-item-icon">
                  {repo.private
                    ? <Icon name="Lock" size={12} />
                    : <Icon name="BookMarked" size={12} />}
                </span>

                {/* Main content */}
                <span className="github-repo-item-body">
                  {/* Line 1: owner/name */}
                  <span className="github-repo-item-name">
                    <span className="github-repo-item-owner">{owner}</span>
                    <span className="github-repo-item-reponame">{repoName}</span>
                  </span>
                  {/* Line 2: description — only rendered when present */}
                  {repo.description && (
                    <span className="github-repo-item-desc">{repo.description}</span>
                  )}
                </span>

                {/* Trailing: updated time at rest, clone affordance / cloning state on hover */}
                <span className="github-repo-item-trail">
                  {isCloning ? (
                    <span className="github-repo-cloning-hint">
                      <Icon name="Loader" size={11} />
                      <span>Cloning…</span>
                    </span>
                  ) : (
                    <>
                      {updatedLabel && (
                        <span className="github-repo-item-updated">{updatedLabel}</span>
                      )}
                      <span className="github-repo-clone-label">Clone</span>
                    </>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
