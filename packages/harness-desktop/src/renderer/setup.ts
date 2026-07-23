/**
 * Setup-window renderer. Pure DOM; talks to main only through the
 * `window.sapiomSetup` bridge exposed by the preload. Renders the boot
 * progress, a first-run telemetry consent prompt, and an error/retry state.
 */
import type { SetupBridge } from "../preload/setup.js";
import type { BootProgress, BootErrorPayload } from "../main/ipc.js";

declare global {
  interface Window {
    sapiomSetup: SetupBridge;
  }
}

const bridge = window.sapiomSetup;

const statusEl = document.getElementById("status")!;
const detailEl = document.getElementById("detail")!;
const consentEl = document.getElementById("consent") as HTMLElement;
const consentCheckbox = document.getElementById("telemetry") as HTMLInputElement;
const consentContinue = document.getElementById("consent-continue") as HTMLButtonElement;
const errorEl = document.getElementById("error") as HTMLElement;
const errorMsgEl = document.getElementById("error-message")!;
const retryBtn = document.getElementById("retry") as HTMLButtonElement;

const PHASE_LABEL: Record<BootProgress["phase"], string> = {
  starting: "Starting Sapiom…",
  doctor: "Checking your environment…",
  "installing-agent": "Setting up your coding agent…",
  auth: "Signing you in…",
  consent: "One quick question…",
  "choosing-folder": "Choosing your project folder…",
  launching: "Launching…",
  ready: "Ready.",
};

bridge.onProgress((p: BootProgress) => {
  statusEl.textContent = PHASE_LABEL[p.phase] ?? p.message;
  detailEl.textContent = p.message;
  statusEl.dataset.status = p.status;
  if (p.phase === "consent" && p.status === "active") {
    consentEl.hidden = false;
  }
});

bridge.onError((e: BootErrorPayload) => {
  errorEl.hidden = false;
  errorMsgEl.textContent = e.detail ? `${e.message}\n\n${e.detail}` : e.message;
  retryBtn.hidden = !e.retryable;
});

consentContinue.addEventListener("click", () => {
  consentEl.hidden = true;
  void bridge.submitConsent(consentCheckbox.checked);
});

retryBtn.addEventListener("click", () => {
  errorEl.hidden = true;
  void bridge.retry();
});
