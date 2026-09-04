/**
 * THE CREATE VERB'S FOLDER STEP: native on desktop, a dialog on the web.
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
 * lives here rather than at each entry point, because there is more than one
 * entry point and two copies of this branch would eventually disagree.
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
  /** The web fallback: show the folder dialog. */
  openDialog: () => void;
  /** A folder the user settled on. Not called when they cancel. */
  onPicked: (root: string) => void;
}

/**
 * Ask for a folder the best way this host can.
 *
 * Resolves once the question has been ASKED, not answered: the dialog path
 * returns as soon as the dialog is open. Only the native path has an answer to
 * wait for, and a cancelled or failed pick is a no-op rather than an error —
 * dismissing a folder browser is not a failure, and there is nothing to report.
 */
export async function chooseProjectFolder(host: FolderStepHost): Promise<void> {
  if (!host.chooseDirectory) {
    host.openDialog();
    return;
  }
  let picked: string | null = null;
  try {
    picked = await host.chooseDirectory(host.startingAt ?? undefined);
  } catch {
    return;
  }
  if (picked) host.onPicked(picked);
}
