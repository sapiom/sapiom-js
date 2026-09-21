/**
 * THE FOLDER STEP: native on desktop, a dialog on the web (flow-creation.md
 * §4.1 step 2, design-eng D29).
 *
 * New project and Add project both begin by asking "which folder". With Finder
 * or Explorer available, a Studio dialog wrapping a text field is a worse
 * control than the OS picker, so the bridge decides whether OUR dialog opens
 * at all. That decision lives here rather than at each entry point, because
 * there is more than one entry point and two copies of this branch would
 * eventually disagree.
 *
 * A function rather than a hook, and pure over its inputs, because the desktop
 * half cannot be exercised in this repo: there is no Electron in the test
 * environment, and the browser half is the only one an e2e run can reach. A
 * branch that only one host can run needs a test that does not need that host.
 * See `folder-step.test.ts`.
 */

export interface FolderStepHost {
  /**
   * The desktop bridge's directory picker, or null in a browser. Feature
   * detected by the caller, never assumed: an older desktop build without it
   * reads as a browser and takes the fallback, which is always safe.
   */
  chooseDirectory: ((startingAt?: string) => Promise<string | null>) | null;
  /** Where the OS picker should open. Ignored by the fallback, which has its
   *  own starting folder. */
  startingAt?: string | null;
  /** The web fallback: show the one-field folder dialog. */
  openDialog: () => void;
  /** A folder the user settled on. Not called when they cancel. */
  onPicked: (root: string) => void;
}

/**
 * Ask for a folder the best way this host can.
 *
 * Resolves once the question has been ASKED, not answered: the dialog path
 * returns as soon as the dialog is open. Only the native path has an answer to
 * wait for, and a cancelled or failed pick is a no-op rather than an error.
 * Dismissing a folder browser is not a failure, and there is nothing to report.
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
