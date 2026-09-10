/**
 * ASKING FOR A FOLDER: native on desktop, our dialog on the web.
 *
 * The split already existed, one level too deep. `FolderField` asks
 * `getDesktopBridge()?.chooseDirectory` and uses the answer to decide whether
 * to render a `<datalist>` — so on desktop the app still opened a modal
 * wrapping a text input, and offered the OS folder browser as a button inside
 * it. That is backwards. With Finder or Explorer available, our dialog is not a
 * smaller version of it; it is a different and worse control, and the typed
 * path is what a browser host is left with when it has nothing better.
 *
 * So the bridge decides whether the DIALOG OPENS AT ALL, and that decision
 * lives here rather than inline at the caller, so the hosts cannot drift apart
 * as more entrances start asking this same question.
 *
 * Only `StartDialog`'s `open` mode is routed through this today, because that
 * mode asks exactly one question — which folder — and has exactly one action.
 * `detect` mode still opens the dialog on both hosts: it has to show what it
 * found under the folder, so the picker is only its first step.
 *
 * A FUNCTION RATHER THAN A HOOK, and pure over its inputs, because the desktop
 * half cannot be exercised in this repo: there is no Electron in the test
 * environment, and the browser half is the only one an e2e run can reach. A
 * branch that only one host can run needs a test that does not need that host.
 * See `folder-step.test.ts`.
 */

export interface FolderStepHost {
  /**
   * The desktop bridge's directory picker, or null in a browser. Feature
   * detected by the caller, never assumed — an older desktop build without it
   * reads as a browser and takes the fallback, which is always safe.
   */
  chooseDirectory: ((startingAt?: string) => Promise<string | null>) | null;
  /** Where the OS picker should open. Ignored by the fallback, which has its
   *  own recents and its own starting folder. */
  startingAt?: string | null;
  /** The web fallback: show our own folder dialog. */
  openDialog: () => void;
  /** A folder the user settled on. Not called when they cancel. */
  onPicked: (root: string) => void;
}

/**
 * Ask for a folder the best way this host can.
 *
 * Resolves once the question has been ASKED, not answered: the dialog path
 * returns as soon as the dialog is open. Only the native path has an answer to
 * wait for.
 *
 * CANCELLING AND FAILING ARE DIFFERENT ANSWERS, and they were conflated here.
 * Cancelling resolves `null` and is a no-op — dismissing a folder browser is
 * not a failure and there is nothing to report. A REJECTION is not a decline:
 * it means the bridge is broken, and swallowing it left the only entrance to
 * adding a project doing nothing at all, with no way through. The typed-path
 * dialog still works on this host, so a failure falls back to it.
 */
export async function chooseProjectFolder(host: FolderStepHost): Promise<void> {
  if (!host.chooseDirectory) {
    host.openDialog();
    return;
  }
  let picked: string | null = null;
  try {
    // `||`, NOT `??`: an empty string has to be omitted too, not forwarded as
    // an empty `defaultPath`. `launchDir` reaches callers through `?? null`,
    // which lets `""` past, and "start at nowhere" is not a starting folder.
    picked = await host.chooseDirectory(host.startingAt || undefined);
  } catch {
    // Not a decline — see above. Leave the user a working way to answer.
    host.openDialog();
    return;
  }
  if (picked) host.onPicked(picked);
}
