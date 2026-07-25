/**
 * IPC contract between the main process and the setup window (the pre-SPA
 * onboarding UI). Channel names live here so main, preload, and renderer agree.
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
