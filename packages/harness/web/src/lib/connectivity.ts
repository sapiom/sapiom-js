/**
 * Connectivity + auth signals for the Studio shell.
 *
 * The Studio must degrade gracefully — no crash, no white-screen, no
 * lockout — when there's no internet or the held token is dropped/expired.
 * Two real signals drive that:
 *   1. `navigator.onLine` (+ the `online`/`offline` events) — the browser's
 *      own view of whether a network is reachable at all.
 *   2. The kind of a failed boot fetch — a 401/403 is a recoverable *auth*
 *      state (pairs with the server-side token refresh) rather than a dead
 *      end; a network-level throw is an *offline* state; anything else is a
 *      generic error.
 *
 * `classifyConnectivity` is the pure part (unit-tested): given the current
 * online flag and an optional boot error, it names the honest state the shell
 * should show. `useConnectivity` is the thin browser wrapper that tracks
 * `navigator.onLine` live so a mid-session network drop is reflected without
 * a reload.
 */
import { useEffect, useState } from "react";

/** HTTP statuses that mean "your credential was rejected" — recoverable in
 *  place (the server re-reads a rotated key on the next request; retrying the
 *  boot fetch is enough to recover), never a hard lockout. */
export const AUTH_ERROR_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** A failed request, reduced to just what the classifier needs. `status` is
 *  the HTTP status when the request reached the server (an `ApiError`);
 *  `networkError` is true when `fetch` itself rejected (no response at all —
 *  DNS/offline/CORS), which browsers surface as a `TypeError`. */
export interface ConnectivityErrorInput {
  /** HTTP status of a non-2xx response, or undefined for a network-level throw. */
  status?: number;
  /** True when the fetch never got a response (offline / unreachable host). */
  networkError?: boolean;
}

/**
 * The honest state of the shell's link to the outside world:
 *  - `online`  — connected, no blocking error.
 *  - `offline` — the browser reports no network, OR a boot fetch failed at the
 *                network level. The app stays legible; actions that need the
 *                network are the ones that can't complete.
 *  - `auth`    — reached the server but the credential was rejected (401/403).
 *                Recoverable: retrying re-hits the endpoint after the server
 *                has had a chance to refresh the held key.
 *  - `error`   — reached the server and got some other failure (5xx, bad
 *                payload). Recoverable via retry; not a connectivity problem.
 */
export type ConnectivityStatus = "online" | "offline" | "auth" | "error";

/** True for an error that means "the request never reached a server". */
export function isNetworkError(
  error: ConnectivityErrorInput | null | undefined,
): boolean {
  if (!error) return false;
  // A network-level throw carries no HTTP status; an explicit flag also counts.
  return error.networkError === true || error.status === undefined;
}

/** True for an error that means "the server rejected the credential". */
export function isAuthError(
  error: ConnectivityErrorInput | null | undefined,
): boolean {
  return error?.status !== undefined && AUTH_ERROR_STATUSES.has(error.status);
}

/**
 * PURE: name the connectivity state from the current online flag and an
 * optional error. Offline wins over everything (an offline device can't
 * meaningfully re-auth), then auth, then any other error; absent an error
 * and while online, `online`. This ordering is the one the shell relies on to
 * pick which recoverable affordance to show, so it's the unit-tested contract.
 */
export function classifyConnectivity(input: {
  online: boolean;
  error?: ConnectivityErrorInput | null;
}): ConnectivityStatus {
  const { online, error } = input;
  // The browser says there's no network, or the failure was a network throw:
  // offline is the truthful state regardless of what else an error carries.
  if (!online || isNetworkError(error)) return "offline";
  if (isAuthError(error)) return "auth";
  if (error) return "error";
  return "online";
}

/** Reads `navigator.onLine`, defaulting to online when the API is absent
 *  (non-browser/test env) so nothing renders a false offline state. */
export function readOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  // Some environments leave `onLine` undefined; treat only an explicit false
  // as offline so we never fabricate an offline state from a missing API.
  return navigator.onLine !== false;
}

/**
 * Live `navigator.onLine` as React state, kept current via the `online` /
 * `offline` window events. Consumers combine this with a boot error via
 * `classifyConnectivity` to pick the honest shell state.
 */
export function useConnectivity(): boolean {
  const [online, setOnline] = useState<boolean>(readOnline);

  useEffect(() => {
    const update = (): void => setOnline(readOnline());
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    // Re-read on mount in case the flag changed between the initial render and
    // the effect (a fast offline flip during hydration).
    update();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return online;
}
