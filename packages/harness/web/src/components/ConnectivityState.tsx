/**
 * Honest connectivity affordances for the Studio shell.
 *
 * Two surfaces, both wired to REAL signals (navigator.onLine + the kind of a
 * failed boot fetch — see lib/connectivity.ts):
 *
 *  - `ConnectivityScreen` replaces the shell's old bare "Failed to load"
 *    white screen when the FIRST fetch fails. It names the honest state
 *    (offline / session expired / couldn't reach the server) and always
 *    offers a way forward (Retry re-runs the boot fetch in place — the
 *    recovery path, so a dropped token or a dropped network is never a hard
 *    lockout). No fabricated data: it shows the state, not a fake app.
 *
 *  - `ConnectivityBanner` is a thin, non-blocking strip (same recipe as the
 *    telemetry notice) shown when the network drops AFTER the app has loaded.
 *    The Studio stays fully usable/legible against its last-known state; the
 *    banner just tells the truth about why live actions may not complete, and
 *    clears itself the moment connectivity returns.
 */
import type { JSX } from "react";

import type { ConnectivityStatus } from "../lib/connectivity";
import { Icon } from "./Icon";

interface ConnectivityScreenProps {
  /** The classified state — only the non-online states render a screen. */
  status: Exclude<ConnectivityStatus, "online">;
  /** Re-run the boot fetch (recovery path). */
  onRetry: () => void;
  /** True while a retry is in flight, so the button reads "Reconnecting…"
   *  and can't be re-fired mid-request. */
  retrying?: boolean;
  /** The raw error text, shown as a muted secondary line for the generic
   *  error case (never the primary message — that stays human). */
  detail?: string | null;
}

/** Per-state copy: what's true, and the single move that recovers. Absence is
 *  a state with a next action — never an apology, never a fabricated app. */
const SCREEN_COPY: Record<
  ConnectivityScreenProps["status"],
  { icon: string; title: string; body: string }
> = {
  offline: {
    icon: "CloudOff",
    title: "You're offline",
    body: "Sapiom Studio can't reach the network. Check your connection — the moment you're back, retry to pick up right where you left off.",
  },
  auth: {
    icon: "Plug",
    title: "Session needs a refresh",
    body: "Your credential was rejected — it may have rotated or expired. Retry to reconnect with the current key; you won't lose your place.",
  },
  error: {
    icon: "TriangleAlert",
    title: "Couldn't reach Sapiom Studio",
    body: "The server didn't respond as expected. This is usually temporary — retry in a moment.",
  },
};

export function ConnectivityScreen({
  status,
  onRetry,
  retrying = false,
  detail,
}: ConnectivityScreenProps): JSX.Element {
  const copy = SCREEN_COPY[status];
  return (
    <div
      className="app-status connectivity-screen"
      data-testid="connectivity-screen"
      data-status={status}
      role="alert"
    >
      <div className="connectivity-screen-inner">
        <span className="connectivity-screen-icon" aria-hidden="true">
          <Icon name={copy.icon} size={22} />
        </span>
        <span className="connectivity-screen-title">{copy.title}</span>
        <span className="connectivity-screen-body">{copy.body}</span>
        {/* The generic case keeps the raw reason available (muted) for the
            curious/support, without leading with a debug string. */}
        {status === "error" && detail && (
          <span
            className="connectivity-screen-detail"
            data-testid="connectivity-screen-detail"
          >
            {detail}
          </span>
        )}
        <button
          className="btn-primary connectivity-screen-retry"
          data-testid="connectivity-retry"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? "Reconnecting…" : "Retry"}
        </button>
      </div>
    </div>
  );
}

interface ConnectivityBannerProps {
  /** Dismiss the banner for this drop (it reappears on the next offline
   *  transition). Optional — offline banners are informational, not modal. */
  onDismiss?: () => void;
}

/**
 * Non-blocking "you're offline" strip for a mid-session network drop. The app
 * keeps working against its last-known state behind it; this only sets honest
 * expectations about live actions.
 */
export function ConnectivityBanner({
  onDismiss,
}: ConnectivityBannerProps): JSX.Element {
  return (
    <div
      className="connectivity-banner"
      role="status"
      data-testid="connectivity-banner"
    >
      <span className="connectivity-banner-icon" aria-hidden="true">
        <Icon name="CloudOff" size={14} />
      </span>
      <span className="connectivity-banner-text">
        You're offline. The Studio stays usable, but live actions (runs,
        deploys, the terminal) pause until your connection returns.
      </span>
      {onDismiss && (
        <button
          className="connectivity-banner-dismiss"
          aria-label="Dismiss offline notice"
          data-testid="connectivity-banner-dismiss"
          onClick={onDismiss}
        >
          &times;
        </button>
      )}
    </div>
  );
}
