/**
 * Update-window renderer. Pure DOM; talks to main only through the
 * `window.sapiomUpdate` bridge exposed by the preload. Fills in the offered
 * version, wires the toggle + the three actions, and keeps "Later" as the safe
 * keyboard default: Esc / Return defer, while restarting — which ends running agent
 * sessions — is reachable only by an explicit click.
 */
import type { UpdateBridge } from "../preload/update.mjs";

declare global {
  interface Window {
    sapiomUpdate: UpdateBridge;
  }
}

const bridge = window.sapiomUpdate;

const versionHeaderEl = document.getElementById("version-header")!;
const versionBodyEl = document.getElementById("version-body")!;
const autoUpdateEl = document.getElementById("auto-update") as HTMLInputElement;
const skipBtn = document.getElementById("skip") as HTMLButtonElement;
const laterBtn = document.getElementById("later") as HTMLButtonElement;
const restartBtn = document.getElementById("restart") as HTMLButtonElement;

// The version, shown in the header (mono) and inline in the body sentence. Falls
// back to a generic phrase if it wasn't passed (keeps the sentence grammatical).
versionHeaderEl.textContent = bridge.version;
versionBodyEl.textContent = bridge.version || "A new version";

// Toggle reflects the persisted preference and writes back immediately on change —
// independent of which button the user ends on, so closing the window still keeps
// a toggle change.
autoUpdateEl.checked = bridge.autoUpdate;
autoUpdateEl.addEventListener("change", () => {
  void bridge.setAutoUpdate(autoUpdateEl.checked);
});

skipBtn.addEventListener("click", () => void bridge.choose("skip"));
laterBtn.addEventListener("click", () => void bridge.choose("later"));
restartBtn.addEventListener("click", () => void bridge.choose("restart"));

// Safe default: focus Later, and let Esc defer too.
laterBtn.focus();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    void bridge.choose("later");
  }
});
