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

/**
 * SPA → main (invoke): open the OS-native "choose folder" dialog. Resolves with
 * the chosen absolute path, or `null` when the user cancels.
 *
 * Desktop-only, like everything here: the same SPA served by `npx @sapiom/harness`
 * has no bridge, so the folder field keeps its in-app directory listing there. The
 * native picker is strictly a shortcut the SPA feature-detects, never a dependency.
 *
 * Guarded by the same `isTrustedSender` check as `UPDATE_CHECK` — a filesystem
 * chooser triggered by same-origin agent-authored content (served at
 * `/canvas/:sessionId/*`) would be an escalation, so only the SPA at the top frame
 * `/` may open it.
 */
export const CHOOSE_DIRECTORY = "dialog:choose-directory";

/**
 * main → renderer (push): a `sapiom://` deep link was received; navigate the SPA
 * to the target (an agent or a template). A main→renderer SEND, not an invoke, so
 * it is NOT subject to `isTrustedSender` (which guards renderer→main invokes) — it
 * opens no attack surface, it only pushes a target the SPA is free to act on or ignore.
 *
 * Cold-start links (the one that launched the app) are delivered instead as an
 * `agent=` query param on the load URL, so the first render already has them with
 * no IPC race; this channel carries links that arrive while the app is running.
 */
export const DEEP_LINK_NAVIGATE = "deep-link:navigate";

/**
 * A parsed `sapiom://` deep link. Discriminated on `kind` so a new target type
 * can't be silently handled as an agent — the same reasoning the discriminated
 * `UpdateCheckOutcome` above is built on. Mirrored on the SPA side in
 * `harness/web/src/lib/desktop.ts`.
 */
export type DeepLinkTarget = DeepLinkAgentTarget | DeepLinkTemplateTarget;

/**
 * `sapiom://agent/<definitionId>`. `definitionId` is the raw URL segment (a
 * string); the SPA stringifies its numeric `WorkflowInfo.definitionId` to match.
 * `slug` is a display-only hint; `org` lets the SPA notice a link minted for a
 * different signed-in organization.
 */
export interface DeepLinkAgentTarget {
  kind: "agent";
  definitionId: string;
  slug?: string;
  org?: string;
}

/**
 * `sapiom://templates/<id>` — the web app's template-detail "Open in Studio".
 * `templateId` is a registry slug (the same id the gallery route uses); `slug` is
 * an optional display/folder hint.
 */
export interface DeepLinkTemplateTarget {
  kind: "template";
  templateId: string;
  slug?: string;
}
/*
 * There is deliberately NO "apply the update" channel reachable from the MAIN
 * window. The restart is destructive — it ends every running agent session — and
 * the main window shares its origin with the agent-authored files the harness
 * serves at `/canvas/:sessionId/*`, so any channel it could reach would be
 * reachable by that content too.
 *
 * The apply confirmation therefore lives in a separate, main-process-owned window
 * (see `update-window.ts`) that loads ONLY our bundled `update.html` — never remote
 * or agent content — carries its own dedicated preload (none of `sapiomDesktop`),
 * and answers on the two channels below. Both are gated on the sender BEING that
 * exact window's `webContents`, and are registered only while it is open, so no
 * other renderer — not the SPA, not a canvas/preview window — can reach them. The
 * invariant is intact: page content still cannot trigger a restart.
 */

/** The user's choice in the update window. `later` also covers closing the window. */
export type UpdateChoice = "restart" | "later" | "skip";

/**
 * update window → main (invoke): the user picked an action, resolving the
 * `showUpdatePrompt` promise. Sender-gated to the update window (see above), NOT
 * via `isTrustedSender` — that guard is specific to the main window's SPA.
 */
export const UPDATE_DECIDE = "update:decide";

/**
 * update window → main (invoke): the "Automatically download and install updates"
 * toggle changed. Persisted (`update-prefs.ts`) and applied live to
 * `autoUpdater.autoInstallOnAppQuit`. Separate from UPDATE_DECIDE so flipping the
 * toggle and THEN closing the window still keeps the change. Same sender gate.
 */
export const UPDATE_SET_AUTO = "update:set-auto";

/**
 * argv prefixes carrying the update window's initial state into its preload — the
 * offered version, and the auto-update toggle state ("1"/"0"). Same documented
 * `additionalArguments` mechanism as APP_VERSION_ARG (a `process.env` read would
 * depend on a renderer inheriting a var mutated after startup).
 */
export const UPDATE_VERSION_ARG = "--sapiom-update-version=";
export const UPDATE_AUTO_ARG = "--sapiom-update-auto=";

/**
 * main → renderer (push): the downloaded-update state changed, or a freshly
 * loaded page is being told the current state. Carries `UpdateStatePayload`.
 *
 * Like DEEP_LINK_NAVIGATE, a SEND rather than an invoke — it opens no attack
 * surface; it only tells the SPA whether its "Update now" card should exist.
 * The card's CLICK goes through the existing UPDATE_CHECK invoke, whose
 * pending branch re-raises the native restart dialog — so the no-apply-channel
 * rule above is untouched: page code still cannot end a session.
 *
 * Re-sent on every `did-finish-load` because renderer state dies on reload but
 * the main process's `pending` does not — without the re-send, a reloaded SPA
 * would silently lose the card until the next download event.
 */
export const UPDATE_STATE = "update:state";

/** What the SPA needs to render (or retract) its "Update now" card. `none`
 *  retracts it — e.g. an apply failed and the pending update was cleared. */
export type UpdateStatePayload =
  | { kind: "none" }
  | { kind: "downloaded"; version: string };

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
  /**
   * The channel has nothing to offer yet. Distinct from `failed` on purpose: a
   * stable install correctly ignores pre-releases, so before the first final
   * release this is the CORRECT answer, and dressing it up as an error teaches
   * users to distrust the feature.
   */
  | { kind: "no-release"; channel: string }
  /** Updates are off for this build (unpackaged, or an env opt-out). */
  | { kind: "disabled"; reason: string }
  | { kind: "failed"; message: string };
