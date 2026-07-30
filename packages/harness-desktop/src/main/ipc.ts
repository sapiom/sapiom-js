/**
 * IPC contract between the main process and its renderers. Channel names live
 * here so main, preload, and renderer agree.
 *
 * Two renderers, and they are very different:
 *  - the **setup window**, our own onboarding UI (BOOT_* / CONSENT_SUBMIT / RETRY);
 *  - the **main window**, which loads the harness SPA — code that also runs in a
 *    plain browser under `npx @sapiom/harness`, where none of this exists. Anything
 *    exposed to it must therefore be feature-detected on the SPA side, never
 *    assumed (see `harness/web/src/lib/desktop.ts`).
 */

/** main → renderer: a step of the boot sequence changed state. */
export const BOOT_PROGRESS = "boot:progress";
/** main → renderer: boot failed; show error + retry affordance. */
export const BOOT_ERROR = "boot:error";
/** renderer → main (invoke): user answered the telemetry consent. Returns void. */
export const CONSENT_SUBMIT = "consent:submit";
/** renderer → main (invoke): user asked to retry (e.g. after agent-install fail). */
export const RETRY = "boot:retry";

export type BootPhase =
  | "starting"
  | "doctor"
  | "installing-agent"
  | "auth"
  | "consent"
  | "choosing-folder"
  | "launching"
  | "ready";

export interface BootProgress {
  phase: BootPhase;
  message: string;
  /** "active" while running, "done" when the step completed, "error" on failure. */
  status: "active" | "done" | "error";
}

export interface BootErrorPayload {
  message: string;
  detail?: string;
  /** When true the renderer shows a "Retry" button wired to RETRY. */
  retryable: boolean;
}

/**
 * Prefix of the argv flag carrying the app version into the main window's preload.
 *
 * `webPreferences.additionalArguments` is Electron's documented way to hand a
 * preload a value at window-creation time. The obvious alternative — setting
 * `process.env` in main and reading it in the preload — depends on a renderer
 * inheriting an env var mutated after startup, which is not something to rely on.
 */
export const APP_VERSION_ARG = "--sapiom-app-version=";

/** SPA → main (invoke): check for an update now. Returns `UpdateCheckOutcome`. */
export const UPDATE_CHECK = "update:check";
/*
 * There is deliberately NO "apply the update" channel. The restart is destructive —
 * it ends every running agent session — and the page that would call it is the same
 * origin as the agent-authored files the harness serves at `/canvas/:sessionId/*`.
 * Rather than exposing that and guarding it, the confirmation lives in a native
 * dialog the main process raises: page content cannot reach it at all.
 */

/**
 * The result of an on-demand check.
 *
 * Deliberately STRUCTURED rather than a ready-made sentence: the renderer owns
 * the wording (it's the only side that knows the surrounding UI), and a
 * discriminated union means a new state can't be silently rendered as a stale
 * string. The scheduled 4-hour check ignores all of this — it only ever surfaces
 * the native "restart to update" dialog.
 */
export type UpdateCheckOutcome =
  /** A newer version exists and is downloading now (autoDownload is on). */
  | { kind: "available"; version: string }
  /**
   * Already downloaded and waiting — either the user chose "Later" earlier, or a
   * background check finished while they weren't looking. Distinct from
   * "available" because the honest next step is "restart", not "wait".
   */
  | { kind: "downloaded"; version: string }
  | { kind: "up-to-date"; version: string; channel: string }
  /** Updates are off for this build (unpackaged, or an env opt-out). */
  | { kind: "disabled"; reason: string }
  | { kind: "failed"; message: string };
