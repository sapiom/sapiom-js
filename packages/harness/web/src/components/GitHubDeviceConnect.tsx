import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  ConnectGitHubRequest,
  GitHubApiRepoEntry,
  GitHubDevicePollResponse,
  GitHubDeviceStartResponse,
  GitHubStatusResponse,
} from "../lib/api";
import { relativeTimeLabel } from "../lib/relative-time";
import { Icon } from "./Icon";

export interface GitHubDeviceApi {
  deviceStart(): Promise<GitHubDeviceStartResponse>;
  devicePoll(deviceCode: string): Promise<GitHubDevicePollResponse>;
  listRepos(): Promise<GitHubApiRepoEntry[]>;
  status(): Promise<GitHubStatusResponse>;
  disconnect(): Promise<void>;
  clone(req: ConnectGitHubRequest): Promise<string>;
}

interface RepositoriesView {
  kind: "repositories";
  login: string;
  repos: GitHubApiRepoEntry[];
  query: string;
  cloning: string | null;
}

type View =
  | { kind: "loading"; label: string }
  | { kind: "unconfigured" }
  | { kind: "idle" }
  | {
      kind: "awaiting";
      userCode: string;
      verificationUri: string;
      deviceCode: string;
      intervalSec: number;
    }
  | { kind: "error"; message: string }
  | RepositoriesView;

interface GitHubDeviceConnectProps {
  api: GitHubDeviceApi;
  defaultCloneParent?: string | null;
  onSuccess: (path: string) => void;
}

function cloneTarget(parent: string, repoName: string): string {
  const cleanParent = parent.replace(/[\\/]+$/, "");
  const separator =
    cleanParent.includes("\\") && !cleanParent.includes("/") ? "\\" : "/";
  return `${cleanParent}${separator}${repoName}`;
}

export function GitHubDeviceConnect({
  api,
  defaultCloneParent,
  onSuccess,
}: GitHubDeviceConnectProps): JSX.Element {
  const [view, setView] = useState<View>({
    kind: "loading",
    label: "Checking GitHub…",
  });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const apiRef = useRef(api);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  apiRef.current = api;

  const clearTimers = useCallback(() => {
    if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const showRepositories = useCallback(async (login: string): Promise<void> => {
    setView({ kind: "loading", label: "Loading repositories…" });
    try {
      const repos = await apiRef.current.listRepos();
      setView({ kind: "repositories", login, repos, query: "", cloning: null });
    } catch (repoError) {
      setView({
        kind: "error",
        message:
          repoError instanceof Error
            ? repoError.message
            : "Could not load GitHub repositories.",
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiRef.current
      .status()
      .then((status) => {
        if (cancelled) return;
        if (status.configured === false) {
          setView({ kind: "unconfigured" });
        } else if (status.connected) {
          void showRepositories(status.login ?? "GitHub");
        } else {
          setView({ kind: "idle" });
        }
      })
      .catch(() => {
        if (!cancelled) setView({ kind: "idle" });
      });
    return () => {
      cancelled = true;
    };
  }, [showRepositories]);

  const schedulePoll = useCallback(
    (deviceCode: string, intervalSec: number): void => {
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = setTimeout(
        () => {
          void apiRef.current
            .devicePoll(deviceCode)
            .then((result) => {
              switch (result.status) {
                case "authorized":
                  void apiRef.current
                    .status()
                    .then((status) =>
                      showRepositories(status.login ?? "GitHub"),
                    )
                    .catch(() => showRepositories("GitHub"));
                  break;
                case "pending":
                  schedulePoll(deviceCode, intervalSec);
                  break;
                case "slow_down":
                  schedulePoll(
                    deviceCode,
                    (result.interval ?? intervalSec) + 5,
                  );
                  break;
                case "expired":
                  setView({
                    kind: "error",
                    message:
                      "The authorization code expired. Start again to get a new code.",
                  });
                  break;
                case "denied":
                  setView({
                    kind: "error",
                    message: "GitHub authorization was denied.",
                  });
                  break;
              }
            })
            .catch((pollError) => {
              setView({
                kind: "error",
                message:
                  pollError instanceof Error
                    ? pollError.message
                    : "Could not finish GitHub authorization.",
              });
            });
        },
        Math.max(1, intervalSec) * 1000,
      );
    },
    [showRepositories],
  );

  const start = async (): Promise<void> => {
    clearTimers();
    setError(null);
    setView({ kind: "loading", label: "Starting GitHub…" });
    try {
      const result = await apiRef.current.deviceStart();
      const intervalSec = result.interval || 5;
      setView({
        kind: "awaiting",
        userCode: result.user_code,
        verificationUri: result.verification_uri,
        deviceCode: result.device_code,
        intervalSec,
      });
      void navigator.clipboard
        ?.writeText(result.user_code)
        .catch(() => undefined);
      schedulePoll(result.device_code, intervalSec);
    } catch (startError) {
      const message =
        startError instanceof Error
          ? startError.message
          : "Could not start GitHub authorization.";
      setView(
        message.includes("notConfigured") || message.includes("503")
          ? { kind: "unconfigured" }
          : { kind: "error", message },
      );
    }
  };

  const disconnect = async (): Promise<void> => {
    clearTimers();
    try {
      await apiRef.current.disconnect();
    } finally {
      setError(null);
      setView({ kind: "idle" });
    }
  };

  const clone = async (repo: GitHubApiRepoEntry): Promise<void> => {
    if (view.kind !== "repositories" || view.cloning) return;
    setError(null);
    setView({ ...view, cloning: repo.fullName });
    try {
      const name = repo.fullName.split("/").pop() ?? repo.fullName;
      const path = await apiRef.current.clone({
        repoUrl: repo.cloneUrl,
        ...(defaultCloneParent
          ? { targetDir: cloneTarget(defaultCloneParent, name) }
          : {}),
      });
      onSuccess(path);
    } catch (cloneError) {
      setError(
        cloneError instanceof Error
          ? cloneError.message
          : "Could not clone this repository.",
      );
      setView({ ...view, cloning: null });
    }
  };

  if (view.kind === "loading") {
    return (
      <div className="github-connect-state" data-testid="github-device-loading">
        <Icon name="Loader" size={14} />
        <span>{view.label}</span>
      </div>
    );
  }

  if (view.kind === "unconfigured") {
    return (
      <div
        className="github-connect-state github-connect-state-error"
        data-testid="github-device-unconfigured"
      >
        <Icon name="TriangleAlert" size={14} />
        <span>GitHub OAuth is not configured in this Studio build.</span>
      </div>
    );
  }

  if (view.kind === "idle" || view.kind === "error") {
    return (
      <div className="github-connect-empty">
        <span className="github-connect-mark" aria-hidden="true">
          <Icon name="GitBranch" size={20} />
        </span>
        <div className="github-connect-empty-copy">
          <strong>Connect your GitHub account</strong>
          <span>
            Authorize once, then choose a repository to clone into Agent Studio.
          </span>
        </div>
        {view.kind === "error" && (
          <div className="modal-error" data-testid="github-device-error">
            {view.message}
          </div>
        )}
        <button
          type="button"
          className="btn-primary"
          data-testid={
            view.kind === "error"
              ? "github-device-retry"
              : "github-device-start"
          }
          onClick={() => void start()}
        >
          <Icon name="GitBranch" size={14} />
          {view.kind === "error" ? "Try again" : "Connect GitHub"}
        </button>
      </div>
    );
  }

  if (view.kind === "awaiting") {
    return (
      <div
        className="github-connect-awaiting"
        data-testid="github-device-awaiting"
      >
        <span className="github-connect-eyebrow">
          Enter this code on GitHub
        </span>
        <button
          type="button"
          className="github-connect-code"
          data-testid="github-device-code"
          data-tooltip="Copy authorization code"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(view.userCode)
              .catch(() => undefined);
            setCopied(true);
            if (copyTimerRef.current !== null)
              clearTimeout(copyTimerRef.current);
            copyTimerRef.current = setTimeout(() => setCopied(false), 2_000);
          }}
        >
          <span>{view.userCode}</span>
          <span className="github-connect-code-copy">
            <Icon name="Copy" size={12} /> {copied ? "Copied" : "Copy"}
          </span>
        </button>
        <p className="modal-field-hint">
          Copy the code, then open GitHub and approve Sapiom Studio.
        </p>
        <a
          className="btn-primary github-connect-open"
          href={view.verificationUri}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="github-device-link"
        >
          Open GitHub <Icon name="ArrowUpRight" size={13} />
        </a>
        <div className="github-connect-waiting" aria-live="polite">
          <Icon name="Loader" size={12} /> Waiting for authorization…
        </div>
      </div>
    );
  }

  const query = view.query.trim().toLowerCase();
  const repos = query
    ? view.repos.filter((repo) => repo.fullName.toLowerCase().includes(query))
    : view.repos;

  return (
    <div className="github-connect-repositories" data-testid="github-repo-list">
      <div className="github-connect-account">
        <span>
          <Icon name="Check" size={12} /> {view.login}
        </span>
        <button
          type="button"
          className="github-connect-disconnect"
          data-testid="github-device-disconnect"
          onClick={() => void disconnect()}
        >
          Disconnect
        </button>
      </div>
      <label className="github-connect-search">
        <Icon name="Search" size={13} />
        <input
          type="search"
          value={view.query}
          placeholder="Search repositories"
          aria-label="Search repositories"
          data-testid="github-repo-search"
          onChange={(event) => setView({ ...view, query: event.target.value })}
        />
      </label>
      {error && (
        <div
          className="modal-error github-connect-error"
          data-testid="github-clone-error"
        >
          {error}
        </div>
      )}
      <div className="github-connect-list" data-testid="github-repo-list-items">
        {repos.length === 0 ? (
          <div className="github-connect-no-results">
            No repositories match.
          </div>
        ) : (
          repos.map((repo) => {
            const name = repo.fullName.split("/").pop() ?? repo.fullName;
            const cloning = view.cloning === repo.fullName;
            return (
              <button
                key={repo.fullName}
                type="button"
                className="github-connect-repo"
                disabled={view.cloning !== null}
                data-testid={`github-repo-item-${name}`}
                onClick={() => void clone(repo)}
                title={
                  defaultCloneParent
                    ? `Clone into ${cloneTarget(defaultCloneParent, name)}`
                    : `Clone ${repo.fullName}`
                }
              >
                <span className="github-connect-repo-icon">
                  <Icon
                    name={repo.private ? "LockKeyhole" : "BookMarked"}
                    size={13}
                  />
                </span>
                <span className="github-connect-repo-copy">
                  <strong>{repo.fullName}</strong>
                  {repo.description && <span>{repo.description}</span>}
                </span>
                <span className="github-connect-repo-trail">
                  {cloning ? (
                    <>
                      <Icon name="Loader" size={11} /> Cloning…
                    </>
                  ) : repo.updatedAt ? (
                    relativeTimeLabel(new Date(repo.updatedAt).getTime())
                  ) : (
                    "Clone"
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
