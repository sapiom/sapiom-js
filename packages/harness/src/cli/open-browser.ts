import open from "open";

type OpenUrl = (url: string) => Promise<unknown>;

/**
 * Opens the already-started Studio in the user's browser.
 *
 * Browser launch is convenience, not server liveness. The startup banner is
 * printed before this runs and contains the exact tokenized URL, so a platform
 * opener failure must leave the healthy server running and point the user back
 * to that fallback instead of reaching the CLI's fatal top-level handler.
 */
export async function openStudioInBrowser(
  url: string,
  openUrl: OpenUrl = open,
): Promise<boolean> {
  try {
    await openUrl(url);
    return true;
  } catch {
    // Do not echo the error: platform opener errors can include `url`, whose
    // query contains the live per-boot access token. The banner immediately
    // above already printed the one intentional copy.
    console.error(
      "\n⚠ Agent Studio could not open a browser automatically. Open the full URL printed above on this machine.\n",
    );
    return false;
  }
}
