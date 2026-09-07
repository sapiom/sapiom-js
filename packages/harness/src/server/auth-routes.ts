/**
 * In-app auth routes — expose the CLI's browser OAuth flow over HTTP so the
 * Studio web app can trigger sign-in/sign-out without restarting the server.
 *
 * Reuses `performBrowserAuth` from `@sapiom/mcp/auth` (the SAME function the
 * CLI's `ensureAuthenticated` calls at boot) — no custom OAuth implementation,
 * no changes to any Sapiom cloud endpoint. The flow:
 *
 *   POST /api/auth/start
 *     ↳ performBrowserAuth(appURL, apiURL)    ← existing CLI flow, unchanged
 *         opens browser → localhost callback → token exchange
 *     ↳ writeCredentials(...)                 ← writes ~/.sapiom/credentials.json
 *     ↳ apiKeyProvider.refresh()              ← adopts the new key in-process
 *     ↳ bus.publish({ type: "auth.changed" }) ← notifies open WS connections
 *
 *   POST /api/auth/disconnect
 *     ↳ clearCredentials(...)
 *     ↳ provider.clear()
 *     ↳ bus.publish({ type: "auth.changed", authenticated: false })
 *
 *   GET /api/auth/status
 *     ↳ { authenticated, organizationName }
 *
 * All three routes sit behind the existing `X-Harness-Token` middleware applied
 * at the /api level in server/index.ts — no extra auth layer needed here.
 */

import { Router } from "express";
import {
  resolveEnvironment,
  performBrowserAuth,
  writeCredentials,
  clearCredentials,
} from "@sapiom/mcp/auth";

import type { EventBus } from "../core/event-bus.js";

// ---------------------------------------------------------------------------
// Mutable auth state
// ---------------------------------------------------------------------------

export interface AuthState {
  authenticated: boolean;
  organizationName: string | null;
}

/**
 * A mutable holder for the harness's current auth identity — updated on
 * sign-in/sign-out and queried by `GET /api/auth/status`. Shared between the
 * auth router and any other consumer (e.g. `GET /api/state` in rest.ts) that
 * wants live auth state rather than the boot-time snapshot.
 */
export interface MutableAuthState {
  get(): AuthState;
  set(state: AuthState): void;
}

export function createMutableAuthState(initial: AuthState): MutableAuthState {
  let current = { ...initial };
  return {
    get: () => ({ ...current }),
    set: (state) => {
      current = { ...state };
    },
  };
}

// ---------------------------------------------------------------------------
// Provider write-back seam
// ---------------------------------------------------------------------------

/**
 * The minimal slice of {@link ApiKeyProvider} the auth router needs: a way
 * to push a new key in after a successful browser auth (or clear it on
 * disconnect), without importing the full provider shape.
 */
export interface AuthKeyTarget {
  /**
   * Re-reads `~/.sapiom/credentials.json` and adopts the key found there.
   * Called after `performBrowserAuth` + `writeCredentials` complete so the
   * provider's in-memory key matches the freshly written credential.
   */
  refresh(): Promise<string | null>;
  /**
   * Unconditionally zero the in-memory key (sets it to null). Called on
   * disconnect so that the provider returns null immediately — distinct from
   * {@link refresh}, whose guard deliberately keeps the cached key when the
   * store has nothing to offer.
   */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface AuthRoutesOptions {
  /** Mutable auth state shared with `GET /api/state` and `GET /api/auth/status`. */
  authState: MutableAuthState;
  /**
   * The live API key provider — `refresh()` is called after sign-in writes
   * `~/.sapiom/credentials.json` so the in-process key adopts the new value.
   */
  apiKeyProvider: AuthKeyTarget;
  /** The server event bus — broadcasts `auth.changed` after every state transition. */
  bus: EventBus;
  /** Whether this Studio process may read or mutate shared authentication. */
  authEnabled?: boolean;
  /**
   * Overrides SAPIOM_ENVIRONMENT for the OAuth flow. Defaults to
   * `process.env.SAPIOM_ENVIRONMENT` (the same override the CLI uses).
   */
  environment?: string;
  /**
   * Injectable seam for `performBrowserAuth` — lets tests mock the full OAuth
   * round-trip without opening a real browser or binding a local port.
   */
  performBrowserAuthImpl?: typeof performBrowserAuth;
  /** Server-private identity projection for authorization consumers. It is
   * intentionally not added to AuthState or any browser response. */
  onProjectUserChanged?: (userId: string | null) => void;
  /** @deprecated Use onProjectUserChanged; remove in SAP-3152. */
  onPlanningUserChanged?: (userId: string | null) => void;
}

/**
 * Mount the in-app auth routes. The caller is responsible for gating these
 * behind the boot-token middleware (applied at the /api level in
 * server/index.ts before any router) — these routes do NOT add a second layer.
 */
export function createAuthRouter(opts: AuthRoutesOptions): Router {
  const router = Router();

  const {
    authState,
    apiKeyProvider,
    bus,
    authEnabled = true,
    environment,
    performBrowserAuthImpl = performBrowserAuth,
    onProjectUserChanged,
    onPlanningUserChanged,
  } = opts;
  const notifyProjectUserChanged =
    onProjectUserChanged ?? onPlanningUserChanged;

  // Track any in-flight start() call so a second concurrent POST /api/auth/start
  // returns a clear error rather than racing two browser-open flows.
  let pendingAuth: Promise<void> | null = null;
  // Set to true by disconnect while a start is in flight so the async chain
  // can bail before writing credentials / refreshing / broadcasting authenticated.
  let pendingCancelled = false;

  // ---------------------------------------------------------------------------
  // GET /api/auth/status — live auth state (not the boot-time snapshot)
  // ---------------------------------------------------------------------------

  router.get("/auth/status", (_req, res) => {
    res.json(
      authEnabled
        ? authState.get()
        : { authenticated: false, organizationName: null },
    );
  });

  // ---------------------------------------------------------------------------
  // POST /api/auth/start — kick off the browser OAuth flow
  // ---------------------------------------------------------------------------

  router.post("/auth/start", (_req, res) => {
    if (!authEnabled) {
      res.status(403).json({
        error: "authentication is disabled for this Studio process",
      });
      return;
    }

    if (pendingAuth !== null) {
      res.status(409).json({ error: "authentication already in progress" });
      return;
    }

    // Return immediately — the browser flow is async and may take seconds to
    // minutes (user clicking through the Sapiom auth page). The web polls
    // GET /api/auth/status (or listens on /ws/events for auth.changed) to
    // know when it completes.
    res.json({ started: true });

    pendingCancelled = false;
    pendingAuth = (async () => {
      try {
        const env = await resolveEnvironment(
          environment ?? process.env.SAPIOM_ENVIRONMENT,
        );

        const result = await performBrowserAuthImpl(env.appURL, env.apiURL);

        // If disconnect arrived while the browser flow was in progress, treat
        // the resolved result as cancelled — do not write credentials, do not
        // adopt the key, do not broadcast authenticated.
        if (pendingCancelled) return;

        // Write credentials.json — same as cli/auth.ts's ensureAuthenticated,
        // reusing the same file and format so the CLI and Studio share one store.
        await writeCredentials(env.name, env.appURL, env.apiURL, {
          apiKey: result.apiKey,
          tenantId: result.tenantId,
          organizationName: result.organizationName,
          apiKeyId: result.apiKeyId,
        });

        // Adopt the new key in the live provider without a server restart.
        await apiKeyProvider.refresh();

        // Update shared auth state and notify all open WS connections.
        authState.set({
          authenticated: true,
          organizationName: result.organizationName,
        });
        // CLI identity uses tenantId as HarnessIdentity.userId. Update the
        // private live principal in the same committed transition as auth;
        // never expose it in the public auth status payload.
        notifyProjectUserChanged?.(result.tenantId);
        bus.publish({
          type: "auth.changed",
          authenticated: true,
          organizationName: result.organizationName,
        });
      } catch (err: unknown) {
        // OAuth cancelled, state-mismatch, timeout, network error — leave
        // auth state as-is (unauthenticated) and broadcast so the SPA can
        // surface a retry affordance.
        const message =
          err instanceof Error ? err.message : "authentication failed";
        console.error("[harness] auth/start failed:", message);
        bus.publish({
          type: "auth.changed",
          authenticated: false,
          organizationName: null,
        });
      } finally {
        pendingAuth = null;
      }
    })();
  });

  // ---------------------------------------------------------------------------
  // POST /api/auth/disconnect — sign out and clear stored credentials
  // ---------------------------------------------------------------------------

  router.post("/auth/disconnect", async (_req, res, next) => {
    if (!authEnabled) {
      res.status(403).json({
        error: "authentication is disabled for this Studio process",
      });
      return;
    }

    try {
      const env = await resolveEnvironment(
        environment ?? process.env.SAPIOM_ENVIRONMENT,
      );

      // If a sign-in is in flight, neutralize it so a late browser-auth resolve
      // cannot re-authenticate after we've disconnected.
      if (pendingAuth !== null) {
        pendingCancelled = true;
      }

      // Clear the credential store — the next refresh() call will find nothing.
      await clearCredentials(env.name);

      // Zero the in-memory key immediately so getKey() returns null right away,
      // without waiting for the next launch-time or request-retry refresh.
      apiKeyProvider.clear();

      authState.set({ authenticated: false, organizationName: null });
      notifyProjectUserChanged?.(null);
      bus.publish({
        type: "auth.changed",
        authenticated: false,
        organizationName: null,
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
