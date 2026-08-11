/**
 * "Update now  v0.4.2  ›" — the rail's way back to an update the user deferred
 * (or never saw). Rendered only when the desktop app has PUSHED a downloaded
 * state over the bridge, so it can't exist in a browser or claim an update
 * that isn't on disk. `version` is the TARGET build, not the running one.
 *
 * The click does not install anything. It calls the same checkForUpdates()
 * bridge as the account menu item; with an update pending, the main process
 * re-raises its NATIVE "Restart now / Later" dialog — the only surface that
 * can end sessions, deliberately (see lib/desktop.ts). Any other outcome
 * (the update evaporated, updates got disabled) is reported as a toast.
 */
import { useState, type JSX } from "react";

import { describeUpdateOutcome, type DesktopBridge } from "../lib/desktop";
import { Icon } from "./Icon";

export function UpdateCard({
  desktop,
  version,
  onToast,
}: {
  desktop: DesktopBridge;
  version: string;
  onToast: (message: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  const handleClick = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await desktop.checkForUpdates();
      // "downloaded" is the expected answer and needs no toast — the native
      // restart dialog is already up. Anything else is the card being stale,
      // and the outcome text says what actually happened.
      if (outcome.kind !== "downloaded") {
        onToast(describeUpdateOutcome(outcome).text);
      }
    } catch {
      onToast("Couldn't check for updates.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rail-footer-row update-row">
      <button
        className="rail-footer-card update-card"
        data-testid="update-card"
        disabled={busy}
        onClick={() => void handleClick()}
      >
        <span className="update-card-label">Update now</span>
        <span className="update-card-version" data-testid="update-card-version">
          v{version}
        </span>
        <Icon name="ChevronRight" size={14} />
      </button>
    </div>
  );
}
